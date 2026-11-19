#!/usr/bin/env python3
"""Launch a local DSH Docker image with a narrowly scoped model relay."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import stat
import subprocess
import tempfile
import threading
import uuid
from urllib.parse import urlsplit

from model_gateway import make_server, make_unix_server, upstream_address
from search_services import SearchServices


PLUGIN_IDS = frozenset((
    "dsh-browser",
    "dsh-context",
    "dsh-claude-artifacts",
    "dsh-claude-slides",
    "dsh-claude-design",
    "dsh-claude-design-system",
    "dsh-claude-data",
    "dsh-claude-motion",
    "dsh-claude-whiteboard",
    "dsh-crew",
    "dsh-super-kanban",
))


def docker(*args, capture=False):
    """Run Docker without a shell or automatic image downloads."""
    return subprocess.run(["docker", *args], check=True, text=True, capture_output=capture)


def reject_host_sockets(directory):
    """Reject existing Unix sockets without following symlinks or exposing paths."""
    def fail(error):
        raise error

    for root, directories, files in os.walk(directory, followlinks=False, onerror=fail):
        for name in (*directories, *files):
            if stat.S_ISSOCK((Path(root) / name).lstat().st_mode):
                raise ValueError("Mounted directories must not contain host Unix sockets")


def reject_runtime_overlap(workspace):
    """Keep a same-path workspace mount away from runtime and system files."""
    for reserved in map(Path, ("/opt/dsh", "/state", "/etc", "/proc", "/sys", "/dev", "/run", "/usr", "/bin", "/sbin")):
        if workspace == reserved or reserved in workspace.parents or workspace in reserved.parents:
            raise ValueError("Workspace must not overlap container runtime or system directories")


def browser_origin(value):
    """Resolve an exact browser origin to a local IPv4 address and port."""
    try:
        parsed = urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname or "")
        explicit_port = parsed.port
        port = explicit_port if explicit_port is not None else (443 if parsed.scheme.lower() == "https" else 80)
    except (ValueError, TypeError) as error:
        raise ValueError("Browser origins must use a literal local IPv4 address") from error
    local_networks = (ipaddress.ip_network("10.0.0.0/8"), ipaddress.ip_network("172.16.0.0/12"), ipaddress.ip_network("192.168.0.0/16"))
    if parsed.scheme.lower() not in ("http", "https") or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment or not 1 <= port <= 65535 or not isinstance(address, ipaddress.IPv4Address) or not (address.is_loopback or any(address in network for network in local_networks)):
        raise ValueError("Browser origins must be exact HTTP(S) loopback or private IPv4 origins")
    origin = f"{parsed.scheme.lower()}://{address}"
    if parsed.port is not None:
        origin += f":{port}"
    return origin, str(address), port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-patch", type=Path)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model-gateway-mode", choices=("tcp", "unix"), default="tcp")
    parser.add_argument("--model-proxy-port", type=int, default=18081)
    parser.add_argument("--port", type=int, default=3081)
    parser.add_argument("--collector-port", type=int, default=3083)
    parser.add_argument("--approval-file", type=Path)
    parser.add_argument("--plugin", action="append", default=[], metavar="ID", help="install and activate an optional Web plugin; repeat to select more")
    parser.add_argument("--hermes-acp-volume")
    parser.add_argument("--browser-engine", choices=("chromium", "camoufox"), default="chromium", help="browser engine for dsh-browser; Camoufox requires the optional image")
    parser.add_argument("--browser-origin", action="append", default=[], metavar="LOCAL_ORIGIN")
    parser.add_argument("--search", choices=("auto", "off"), default="auto")
    parser.add_argument("--auto-approve-search", action="store_true", help="skip per-request approval for search and public page fetches")
    parser.add_argument("--image", default="dsh-offline:local")
    parser.add_argument("--profile", choices=("web", "headless"), default="web")
    parser.add_argument("--context-window", type=int, default=262144)
    parser.add_argument("--max-tokens", type=int, default=32768)
    parser.add_argument("--max-body", type=int, default=16 * 1024 * 1024)
    parser.add_argument("task", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    upstream_address(args.base_url)
    if os.getuid() == 0:
        parser.error("Run as a non-root user; container applications must not retain root")
    if args.max_tokens > args.context_window:
        parser.error("Maximum output tokens must not exceed the context window")
    if any(plugin not in PLUGIN_IDS for plugin in args.plugin):
        parser.error("Unknown plugin id; see deploy/offline/README.md for available plugins")
    if len(set(args.plugin)) != len(args.plugin):
        parser.error("Each plugin id may be selected once")
    if args.plugin and args.profile != "web":
        parser.error("Optional plugins are available only with --profile web")
    if args.browser_origin and "dsh-browser" not in args.plugin:
        parser.error("--browser-origin requires --plugin dsh-browser")
    if args.browser_engine != "chromium" and "dsh-browser" not in args.plugin:
        parser.error("--browser-engine camoufox requires --plugin dsh-browser")
    try:
        browser_origins = [browser_origin(origin) for origin in args.browser_origin]
    except ValueError as error:
        parser.error(str(error))
    if not 1 <= args.collector_port <= 65535 or args.collector_port == args.port:
        parser.error("Collector port must be valid and distinct from the UI port")
    if not 1 <= args.port <= 65535 or min(args.context_window, args.max_tokens, args.max_body) < 1:
        parser.error("Ports and limits must be positive and valid")
    if not 1024 <= args.model_proxy_port <= 65535:
        parser.error("Model proxy port must be an unprivileged TCP port")
    if args.model_gateway_mode == "unix" and platform.system() != "Linux":
        parser.error("Unix-socket model gateways require Linux")
    search_keys = ("DSH_SEARXNG_URL", "DSH_RUSTXNG_URL")
    search_env = {key: os.environ[key] for key in search_keys if key in os.environ}
    search_network = os.environ.get("DSH_SEARCH_NETWORK")
    if search_env or search_network is not None:
        if len(search_env) != 2 or any(not search_env[key] for key in search_keys) or not search_network:
            parser.error("Local search requires both engine URLs and DSH_SEARCH_NETWORK")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", search_network):
            parser.error("DSH_SEARCH_NETWORK is invalid")
    if args.search == "off" and (search_env or args.auto_approve_search):
        parser.error("Search options cannot be used with --search off")
    workspace = args.workspace.resolve(strict=True)
    state = args.state.resolve()
    home = Path.home()
    model_patch = args.model_patch.resolve(strict=True) if args.model_patch else None
    if args.hermes_acp_volume is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.hermes_acp_volume):
        parser.error("Hermes ACP volume name is invalid")
    if args.hermes_acp_volume is not None and (args.profile != "web" or "dsh-crew" not in args.plugin):
        parser.error("--hermes-acp-volume requires --profile web and --plugin dsh-crew")
    if model_patch is not None and (not model_patch.is_file() or workspace not in model_patch.parents):
        parser.error("Model patch must be a file inside the workspace")
    if not workspace.is_dir() or workspace in (Path("/"), home) or workspace in home.parents:
        parser.error("Workspace must be a project directory and must not contain the host home directory")
    reject_runtime_overlap(workspace)
    if any(character in str(path) for path in (workspace, state) for character in (",", "\n", "\r")):
        parser.error("Mount paths must not contain commas or newlines")
    if state in (workspace, home, Path("/")) or state in home.parents or state in workspace.parents or workspace in state.parents:
        parser.error("State must be a separate private directory")
    approval_file = args.approval_file.resolve() if args.approval_file else None
    if approval_file is not None and any(approval_file == mounted or mounted in approval_file.parents for mounted in (workspace, state)):
        parser.error("Approval file must be outside workspace and state")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    reject_host_sockets(workspace)
    reject_host_sockets(state)
    docker("image", "inspect", args.image, capture=True)
    if args.hermes_acp_volume is not None:
        docker("volume", "inspect", args.hermes_acp_volume, capture=True)
    name = "dsh-offline-" + uuid.uuid4().hex[:12]
    server = None
    gateway_socket_dir = None
    child = None
    network_created = False
    collector_started = False
    approval_written = False
    search_runtime = None
    previous_handlers = {}

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, stop)
        docker("network", "create", name, capture=True)
        network_created = True
        network = json.loads(docker("network", "inspect", name, capture=True).stdout)[0]
        if platform.system() == "Darwin":
            bind, gateway = "127.0.0.1", "host.docker.internal"
        elif platform.system() == "Linux":
            bind = gateway = network["IPAM"]["Config"][0]["Gateway"]
        else:
            raise ValueError("Only macOS and Linux are supported")
        if args.model_gateway_mode == "unix":
            gateway_socket_dir = tempfile.TemporaryDirectory(prefix="dsh-model-gateway-")
            socket_path = Path(gateway_socket_dir.name) / "model.sock"
            server = make_unix_server(socket_path, args.base_url, args.max_body)
            os.chmod(socket_path, 0o600)
        else:
            server = make_server(bind, 0, args.base_url, args.max_body)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        if args.search == "auto" and not search_env:
            cache_root = Path(os.environ.get("XDG_CACHE_HOME", str(home / ".cache"))).expanduser().resolve()
            search_runtime = SearchServices(name, cache_root / "dsh-offline" / "search-services", args.image, docker=docker)
            search_env = search_runtime.start()
            search_network = search_env["DSH_SEARCH_NETWORK"]
        token = secrets.token_urlsafe(32)
        collector_name = name + "-collector"
        collector_command = ["run", "--detach", "--rm", "--pull=never", "--name", collector_name,
                             "--network", name, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                             "--user", "65534:65534", "--workdir", "/opt/dsh",
                             "--publish", f"127.0.0.1:{args.collector_port}:8081",
                             "--env", "DSH_HOME=/opt/dsh/deploy/offline/collector-home",
                             "--env", "DSH_AUTO_APPROVE_SEARCH=" + ("1" if args.auto_approve_search else "0"),
                             "--env", "CONTROL_TOKEN=" + token,
                             "--entrypoint", "node", args.image, "--import", "tsx/esm", "apps/cli/src/bin.ts",
                             "--profile", "public-web", "--patch", "/opt/dsh/deploy/offline/collector.patch.yml"]
        collector_dns = os.environ.get("DSH_COLLECTOR_DNS_SERVER")
        if collector_dns is not None:
            collector_command[1:1] = ["--env", "DSH_COLLECTOR_DNS_SERVER=" + collector_dns]
        if search_env:
            options = []
            for key, value in search_env.items():
                options.extend(("--env", key + "=" + value))
            for filename in ("collector.mjs", "local-search.mjs"):
                source = Path(__file__).resolve().parent / filename
                options.extend(("--mount", f"type=bind,source={source},target=/opt/dsh/deploy/offline/{filename},readonly"))
            collector_command[1:1] = options
        docker(*collector_command, capture=True)
        collector_started = True
        if search_env:
            docker("network", "connect", search_network, collector_name, capture=True)
        collector = json.loads(docker("inspect", collector_name, capture=True).stdout)[0]
        collector_ip = collector["NetworkSettings"]["Networks"][name]["IPAddress"]
        approval_url = f"http://127.0.0.1:{args.collector_port}/#{token}"
        if approval_file is not None:
            with open(approval_file, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                approval_written = True
                output.write(approval_url + "\n")
            print("Web approval URL is in the selected host-only file", flush=True)
        else:
            try:
                with open("/dev/tty", "w") as terminal:
                    terminal.write("Web approval: " + approval_url + "\n")
            except OSError as error:
                raise ValueError("Web approval needs a terminal or host-only --approval-file") from error
        env = {
            "DSH_COLLECTOR_HOST": collector_ip,
            "DSH_COLLECTOR_PORT": "8080",
            "MODEL_GATEWAY_MODE": args.model_gateway_mode,
            "DSH_MODEL_ID": args.model,
            "DSH_WORKSPACE": str(workspace),
            "DSH_UID": str(os.getuid()),
            "DSH_GID": str(os.getgid()),
            "DSH_WEB_PORT": "3080",
            "DSH_PUBLIC_URL": os.environ.get("DSH_PUBLIC_URL", f"http://127.0.0.1:{args.port}"),
            "DSH_CONTEXT_WINDOW": str(args.context_window),
            "DSH_MAX_TOKENS": str(args.max_tokens),
            "DSH_BROWSER_ALLOWED_ORIGINS": json.dumps([origin for origin, _, _ in browser_origins]),
            "DSH_BROWSER_ENGINE": args.browser_engine,
            "DSH_OFFLINE_SELECTED_PLUGINS": json.dumps(args.plugin),
        }
        if args.model_gateway_mode == "unix":
            env.update({
                "DSH_NETWORK_GATEWAY_HOST": gateway,
                "DSH_MODEL_GATEWAY_SOCKET": "/run/dsh-model/model.sock",
                "DSH_MODEL_PROXY_PORT": str(args.model_proxy_port),
            })
        else:
            env["MODEL_GATEWAY_HOST"] = gateway
            env["MODEL_GATEWAY_PORT"] = str(server.server_port)
        if args.hermes_acp_volume is not None:
            env["DSH_HERMES_ACP_ENABLED"] = "1"
        command = ["docker", "run", "--rm", "--pull=never", "--name", name, "--network", name,
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
        for capability in ("NET_ADMIN", "SETUID", "SETGID", "SETPCAP"):
            command.extend(("--cap-add", capability))
        for key, value in env.items():
            command.extend(("--env", key + "=" + value))
        command.extend(("--mount", f"type=bind,source={workspace},target={workspace}",
                        "--mount", f"type=bind,source={state},target=/state"))
        for filename in ("cordis.patch.yml", "prepare-presets.mjs", "hermes.patch.yml"):
            source = Path(__file__).resolve().parent / filename
            command.extend(("--mount", f"type=bind,source={source},target=/opt/dsh/deploy/offline/{filename},readonly"))
        if gateway_socket_dir is not None:
            command.extend(("--mount", f"type=bind,source={gateway_socket_dir.name},target=/run/dsh-model,readonly"))
            for filename in ("entrypoint.sh", "model_socket_proxy.py"):
                source = Path(__file__).resolve().parent / filename
                command.extend(("--mount", f"type=bind,source={source},target=/opt/dsh/deploy/offline/{filename},readonly"))
        if args.hermes_acp_volume is not None:
            command.extend(("--mount", f"type=volume,source={args.hermes_acp_volume},target=/run/hermes-acp,readonly"))
        if args.profile == "web":
            command.extend(("--publish", f"127.0.0.1:{args.port}:3080"))
        command.extend((args.image, args.profile))
        if model_patch is not None:
            command.extend(("--patch", str(model_patch)))
        task = args.task[1:] if args.task[:1] == ["--"] else args.task
        command.extend(task)
        child = subprocess.Popen(command)
        if args.profile == "web":
            print(f"DSH local UI: http://127.0.0.1:{args.port}", flush=True)
        return child.wait()
    except KeyboardInterrupt:
        return 130
    finally:
        if child is not None:
            subprocess.run(["docker", "stop", "--time", "10", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait(timeout=5)
        if collector_started:
            subprocess.run(["docker", "stop", "--time", "10", name + "-collector"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if search_runtime is not None:
            search_runtime.close()
        if approval_written:
            approval_file.unlink(missing_ok=True)
        if server is not None:
            server.shutdown()
            server.server_close()
        if gateway_socket_dir is not None:
            gateway_socket_dir.cleanup()
        if network_created:
            docker("network", "rm", name, capture=True)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # Never print subprocess arguments: headless tasks can contain private data.
        raise SystemExit("Offline launch failed: " + type(error).__name__)
