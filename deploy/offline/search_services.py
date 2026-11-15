"""Reuse DSH-managed search containers or build pinned upstream sources."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile


SOURCES = {
    "searxng": {
        "url": "https://github.com/searxng/searxng.git",
        "commit": "219b63b207c98b85471de5abab773e76432f1961",
        "image": "dsh-offline/searxng:219b63b207c9",
        "upstream_image": "docker.io/searxng/searxng@sha256:11ffedd387dc9cf99e881250c67861470384e55194a86f76df76aa0034a28a1a",
        "port": 8080,
    },
    "rustxng": {
        "url": "https://github.com/sahenjp/RustXNG.git",
        "commit": "97d330a76597dbabdd3426679c061cd560cd2e1b",
        "image": "dsh-offline/rustxng:97d330a76597",
        "upstream_image": "ghcr.io/sahenjp/rustxng@sha256:9ce389e9d96139734ec042f855be9dbd28a0316fba8a40fa89642271d82196dc",
        "port": 29483,
    },
}
SEARCH_ENGINE_LABEL = "org.deepseek-ai.dsh.search-engine"
SEARCH_CONFIGURATION_LABEL = "org.deepseek-ai.dsh.search-configuration"
SEARCH_CONFIGURATION_VERSION = "offline-v1"


def _run(*args: str, capture: bool = False) -> subprocess.CompletedProcess:
    """Run a fixed argument vector, without a shell."""
    return subprocess.run(["docker", *args], check=True, text=True, capture_output=capture)


def _port(container: dict, engine: str) -> int | None:
    """Return the expected listener port only when the container exposes it."""
    port = SOURCES[engine]["port"]
    exposed = container.get("Config", {}).get("ExposedPorts") or {}
    if f"{port}/tcp" in exposed:
        return port
    return None


def _matches_image(container: dict, engine: str) -> bool:
    """Match a pinned image only when the DSH offline settings label is present."""
    config = container.get("Config", {})
    image = config.get("Image", "")
    labels = config.get("Labels") or {}
    if labels.get(SEARCH_ENGINE_LABEL) != engine or labels.get(SEARCH_CONFIGURATION_LABEL) != SEARCH_CONFIGURATION_VERSION:
        return False
    return image == SOURCES[engine]["upstream_image"]


class SearchServices:
    """Attach reviewed search engines to a temporary internal Docker network."""

    def __init__(self, name: str, cache: Path, image: str, docker=_run):
        self.name = name
        self.cache = cache
        self.image = image
        self.docker = docker
        self.network = name + "-search"
        self.egress_network = name + "-search-egress"
        self.managed: list[str] = []
        self.connected: list[str] = []
        self.networks: list[str] = []
        self.configs: list[Path] = []

    def _clone(self, engine: str) -> Path:
        source = SOURCES[engine]
        target = self.cache / engine
        self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.exists():
            origin = _run(["git", "-C", str(target), "remote", "get-url", "origin"], capture=True).stdout.strip()
            head = _run(["git", "-C", str(target), "rev-parse", "HEAD"], capture=True).stdout.strip()
            if origin != source["url"] or head != source["commit"]:
                raise ValueError(f"Cached {engine} checkout does not match its pinned upstream commit")
            return target

        temporary = Path(tempfile.mkdtemp(prefix=engine + "-", dir=self.cache))
        try:
            _run(["git", "init", str(temporary)])
            _run(["git", "-C", str(temporary), "remote", "add", "origin", source["url"]])
            _run(["git", "-C", str(temporary), "fetch", "--depth=1", "origin", source["commit"]])
            _run(["git", "-C", str(temporary), "checkout", "--detach", "FETCH_HEAD"])
            temporary.rename(target)
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        return target

    def _image(self, engine: str) -> None:
        source = SOURCES[engine]
        try:
            self.docker("image", "inspect", source["image"], capture=True)
            return
        except subprocess.CalledProcessError:
            try:
                self.docker("image", "inspect", source["upstream_image"], capture=True)
            except subprocess.CalledProcessError:
                checkout = self._clone(engine)
                dockerfile = checkout / ("container/Dockerfile" if engine == "searxng" else "Dockerfile")
                self.docker("build", "--pull=false", "--tag", source["image"], "--file", str(dockerfile), str(checkout))
            else:
                self.docker("image", "tag", source["upstream_image"], source["image"])

    def _config(self, engine: str) -> Path:
        self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        if engine == "searxng":
            secret = secrets.token_urlsafe(36)
            contents = f'''use_default_settings:
  engines:
    keep_only: [google, bing, duckduckgo, brave]
general:
  debug: false
  enable_metrics: false
server:
  secret_key: "{secret}"
  limiter: false
  image_proxy: false
search:
  autocomplete: ""
  formats: [json]
engines:
  - name: google
    disabled: false
  - name: bing
    disabled: false
  - name: duckduckgo
    disabled: false
  - name: brave
    disabled: false
'''
            suffix = ".yml"
        else:
            contents = '''[general]
enable_metrics = false

[research]
enabled = false

[fetch]
provider = "direct"

[[engines]]
name = "deepseek"
disabled = true
'''
            suffix = ".toml"
        fd, name = tempfile.mkstemp(prefix=engine + "-", suffix=suffix, dir=self.cache)
        path = Path(name)
        self.configs.append(path)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(contents)
        path.chmod(0o444)
        return path

    def _start_managed(self, engine: str) -> str:
        source = SOURCES[engine]
        self._image(engine)
        name = self.name + "-" + engine
        config = self._config(engine)
        mount = f"type=bind,source={config},target=/etc/searxng/settings.yml,readonly" if engine == "searxng" else f"type=bind,source={config},target=/app/settings.toml,readonly"
        command = ["run", "--detach", "--rm", "--pull=never", "--name", name,
                   "--network", self.egress_network, "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges", "--pids-limit", "256",
                   "--label", f"{SEARCH_ENGINE_LABEL}={engine}",
                   "--label", f"{SEARCH_CONFIGURATION_LABEL}={SEARCH_CONFIGURATION_VERSION}",
                   "--mount", mount, source["image"]]
        if engine == "rustxng":
            command.extend(("--profile", "standard", "--bind", "0.0.0.0", "--port", str(source["port"])))
        self.docker(*command, capture=True)
        self.managed.append(name)
        self.docker("network", "connect", self.network, name, capture=True)
        self.connected.append(name)
        return name

    def start(self) -> dict[str, str]:
        """Reuse one pinned running service of each kind, starting missing engines."""
        self.docker("network", "create", "--internal", self.network, capture=True)
        self.networks.append(self.network)
        ids = [line for line in self.docker("ps", "--quiet", capture=True).stdout.splitlines() if line]
        inspected = json.loads(self.docker("inspect", *ids, capture=True).stdout) if ids else []
        selected: dict[str, dict] = {}
        for engine in SOURCES:
            candidates = [item for item in inspected if _matches_image(item, engine) and _port(item, engine)]
            if len(candidates) > 1:
                raise ValueError(f"Multiple reviewed {engine} containers are running; select services explicitly")
            if candidates:
                selected[engine] = candidates[0]

        if any(engine not in selected for engine in SOURCES):
            self.docker("network", "create", self.egress_network, capture=True)
            self.networks.append(self.egress_network)
        endpoints = {}
        for engine in SOURCES:
            container = selected.get(engine)
            name = container["Name"].lstrip("/") if container else self._start_managed(engine)
            if container:
                self.docker("network", "connect", self.network, name, capture=True)
                self.connected.append(name)
            inspected_container = json.loads(self.docker("inspect", name, capture=True).stdout)[0]
            address = inspected_container["NetworkSettings"]["Networks"][self.network]["IPAddress"]
            if not address:
                raise ValueError(f"Could not address the selected {engine} container on the private search network")
            endpoints[engine] = f"http://{address}:{SOURCES[engine]['port']}"
        probe = '''import socket, sys, time
targets = [(sys.argv[index], int(sys.argv[index + 1])) for index in range(1, len(sys.argv), 2)]
deadline = time.monotonic() + 90
while True:
    try:
        for host, port in targets:
            with socket.create_connection((host, port), timeout=2):
                pass
        break
    except OSError:
        if time.monotonic() >= deadline:
            raise
        time.sleep(1)
'''
        targets = [value for engine in SOURCES for value in (endpoints[engine].split("//", 1)[1].rsplit(":", 1)[0], str(SOURCES[engine]["port"]))]
        self.docker("run", "--rm", "--pull=never", "--network", self.network,
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                    "--entrypoint", "python3", self.image, "-c", probe, *targets,
                    capture=True)
        return {
            "DSH_SEARXNG_URL": endpoints["searxng"],
            "DSH_RUSTXNG_URL": endpoints["rustxng"],
            "DSH_SEARCH_NETWORK": self.network,
        }

    def close(self) -> None:
        """Stop managed services, detach reused services, and remove temporary networks."""
        for name in self.managed:
            try:
                self.docker("stop", "--time", "10", name, capture=True)
            except (OSError, subprocess.CalledProcessError):
                pass
        for name in self.connected:
            if name in self.managed:
                continue
            try:
                self.docker("network", "disconnect", self.network, name, capture=True)
            except (OSError, subprocess.CalledProcessError):
                pass
        for network in reversed(self.networks):
            try:
                self.docker("network", "rm", network, capture=True)
            except (OSError, subprocess.CalledProcessError):
                pass
        for config in self.configs:
            config.unlink(missing_ok=True)
