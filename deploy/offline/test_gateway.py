"""Network tests use only loopback fake model servers."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import threading
import tempfile
import socket
from pathlib import Path
from unittest.mock import MagicMock, patch

import run as launcher
import unittest

from model_gateway import make_server, upstream_address


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.received = []
        received = self.received

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path == "/v1/models" and getattr(self.server, "redirect", False):
                    self.send_response(302)
                    self.send_header("Location", "http://8.8.8.8/")
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"data":[]}')

            def do_POST(self):
                received.append(dict(self.headers))
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: first\n\n')
                self.wfile.flush()
                release = getattr(self.server, "release_stream", None)
                if release is not None:
                    release.wait(timeout=3)
                self.wfile.write(b'data: [DONE]\n\n')

        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        self.gateway = make_server("127.0.0.1", 0, f"http://127.0.0.1:{self.upstream.server_port}/v1", 32)
        for server in (self.upstream, self.gateway):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in (self.gateway, self.upstream):
            server.shutdown()
            server.server_close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.gateway.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_models_and_stream_and_header_scrubbing(self):
        self.assertEqual(self.request("GET", "/v1/models"), (200, b'{"data":[]}'))
        self.assertEqual(self.request("POST", "/v1/chat/completions", "{}", {"Authorization": "secret", "Cookie": "secret"}), (200, b'data: first\n\ndata: [DONE]\n\n'))
        self.assertNotIn("Authorization", self.received[0])
        self.assertNotIn("Cookie", self.received[0])

    def test_stream_arrives_before_upstream_finishes(self):
        self.upstream.release_stream = threading.Event()
        connection = http.client.HTTPConnection("127.0.0.1", self.gateway.server_port, timeout=3)
        connection.request("POST", "/v1/chat/completions", "{}")
        response = connection.getresponse()
        self.assertEqual(response.read(13), b"data: first\n\n")
        self.upstream.release_stream.set()
        self.assertEqual(response.read(), b"data: [DONE]\n\n")
        connection.close()

    def test_redirect_is_not_followed(self):
        self.upstream.redirect = True
        self.assertEqual(self.request("GET", "/v1/models")[0], 502)

    def test_forbidden_routes_and_oversize(self):
        for path in ("/v1/models?x=1", "/admin", "http://example.com/v1/models"):
            self.assertEqual(self.request("GET", path)[0], 403)
        self.assertEqual(self.request("POST", "/v1/completions", "x" * 33)[0], 413)

    def test_reject_public_dns_and_credentials(self):
        for url in ("http://example.com/v1", "http://8.8.8.8/v1", "https://127.0.0.1/v1", "http://secret@127.0.0.1/v1", "http://127.0.0.1/v1?secret=1", "http://169.254.169.254/v1"):
            with self.assertRaises(ValueError):
                upstream_address(url)


class LauncherTests(unittest.TestCase):
    def test_browser_origins_are_exact_private_http_origins(self):
        self.assertEqual(launcher.browser_origin("http://127.0.0.1:4173"), ("http://127.0.0.1:4173", "127.0.0.1", 4173))
        self.assertEqual(launcher.browser_origin("https://192.168.5.20"), ("https://192.168.5.20", "192.168.5.20", 443))
        for origin in (
            "https://public.example",
            "http://192.168.1.2:0",
            "http://192.168.1.2/path",
            "http://user@192.168.1.2",
            "http://[::1]:4173",
        ):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                launcher.browser_origin(origin)

    def test_same_path_mount_cannot_replace_runtime_or_system_files(self):
        for path in ("/opt", "/opt/dsh", "/opt/dsh/project", "/state", "/state/project", "/etc", "/etc/project", "/proc", "/sys", "/dev", "/run", "/usr", "/bin", "/sbin", "/"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "overlap"):
                launcher.reject_runtime_overlap(Path(path))
        for path in ("/Users/recrack/project/dsh", "/home/pigma/project/dsh", "/tmp/project", "/opt/project", "/workspace"):
            launcher.reject_runtime_overlap(Path(path))

    def test_interrupt_cleans_container_gateway_and_network(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "project"
            workspace.mkdir()
            model_patch = workspace / "model.patch.yml"
            model_patch.write_text("[]\n")
            approval_file = Path(directory) / "approval-url"
            calls = []

            def docker(*args, **kwargs):
                calls.append(args)
                result = MagicMock()
                result.stdout = '[{"IPAM":{"Config":[{"Gateway":"172.20.0.1"}]}}]'
                if args[0] == "inspect":
                    network_name = args[1].removesuffix("-collector")
                    result.stdout = '{"NetworkSettings":{"Networks":{"' + network_name + '":{"IPAddress":"172.20.0.2"}}}}'
                    result.stdout = '[' + result.stdout + ']'
                return result

            server = MagicMock(server_port=19000)
            child = MagicMock()
            child.wait.side_effect = [KeyboardInterrupt, 0]
            argv = ["run.py", "--workspace", str(workspace), "--state", directory + "/state",
                    "--model", "local", "--base-url", "http://127.0.0.1:18080/v1", "--approval-file", str(approval_file),
                    "--profile", "headless", "--search", "off", "--model-patch", str(model_patch), "test task"]
            with patch("sys.argv", argv), patch.object(launcher, "docker", side_effect=docker), patch.object(launcher, "make_server", return_value=server), patch.object(launcher.subprocess, "Popen", return_value=child) as launch, patch.object(launcher.subprocess, "run") as stop, patch.object(launcher.platform, "system", return_value="Linux"), patch.object(launcher.os, "getuid", return_value=1000):
                self.assertEqual(launcher.main(), 130)
                self.assertEqual(launch.call_args.args[0][-4:], ["headless", "--patch", str(model_patch.resolve()), "test task"])
                self.assertIn("DSH_OFFLINE_SELECTED_PLUGINS=[]", launch.call_args.args[0])
                self.assertEqual(len(stop.call_args_list), 2)
                self.assertTrue(stop.call_args_list[-1].args[0][-1].endswith("-collector"))
                collector_run = next(call for call in calls if call[:2] == ("run", "--detach"))
                self.assertNotIn("--mount", collector_run)
                self.assertIn("CONTROL_TOKEN=", " ".join(collector_run))

            server.shutdown.assert_called_once()
            server.server_close.assert_called_once()
            self.assertEqual(calls[-1][:2], ("network", "rm"))


    def test_optional_hermes_volume_mounts_read_only_and_loader_patch_is_enabled(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "project"
            workspace.mkdir()
            approval_file = Path(directory) / "approval-url"
            calls = []

            def docker(*args, **kwargs):
                calls.append(args)
                result = MagicMock()
                result.stdout = '[{"IPAM":{"Config":[{"Gateway":"172.20.0.1"}]}}]'
                if args[0] == "inspect":
                    network_name = args[1].removesuffix("-collector")
                    result.stdout = '[{"NetworkSettings":{"Networks":{"' + network_name + '":{"IPAddress":"172.20.0.2"}}}}]'
                return result

            server = MagicMock(server_port=19000)
            child = MagicMock()
            child.wait.return_value = 0
            argv = ["run.py", "--workspace", str(workspace), "--state", directory + "/state",
                    "--model", "local", "--base-url", "http://127.0.0.1:18080/v1",
                    "--approval-file", str(approval_file), "--hermes-acp-volume", "dsh-hermes-acp-socket",
                    "--plugin", "dsh-crew", "--profile", "web", "--search", "off"]
            with patch("sys.argv", argv), patch.object(launcher, "docker", side_effect=docker), patch.object(launcher, "make_server", return_value=server), patch.object(launcher.subprocess, "Popen", return_value=child) as launch, patch.object(launcher.subprocess, "run"), patch.object(launcher.platform, "system", return_value="Linux"), patch.object(launcher.os, "getuid", return_value=1000):
                self.assertEqual(launcher.main(), 0)

            command = launch.call_args.args[0]
            self.assertIn("DSH_HERMES_ACP_ENABLED=1", command)
            self.assertIn('DSH_OFFLINE_SELECTED_PLUGINS=["dsh-crew"]', command)
            self.assertIn("type=volume,source=dsh-hermes-acp-socket,target=/run/hermes-acp,readonly", command)
            self.assertIn(("volume", "inspect", "dsh-hermes-acp-socket"), calls)
            self.assertEqual(child.wait.call_count, 2)


    def test_local_search_requires_both_engines_and_named_private_network_before_docker(self):
        for env in (
            {"DSH_SEARXNG_URL": "http://172.20.0.3:8080"},
            {"DSH_SEARXNG_URL": "http://172.20.0.3:8080", "DSH_RUSTXNG_URL": "http://172.20.0.4:8080"},
            {"DSH_SEARXNG_URL": "http://172.20.0.3:8080", "DSH_RUSTXNG_URL": "http://172.20.0.4:8080", "DSH_SEARCH_NETWORK": "bad network"},
        ):
            argv = ["run.py", "--workspace", "/tmp", "--state", "/tmp/state", "--model", "local", "--base-url", "http://127.0.0.1:18080/v1", "--search", "off"]
            with self.subTest(env=env), patch("sys.argv", argv), patch.dict(os.environ, env, clear=True), patch.object(launcher.os, "getuid", return_value=1000), patch.object(launcher, "docker") as docker, patch("sys.stderr"):
                with self.assertRaises(SystemExit):
                    launcher.main()
                docker.assert_not_called()


    def test_model_patch_outside_workspace_and_symlink_escape_fail_before_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "project"
            workspace.mkdir()
            outside = Path(directory) / "outside.patch.yml"
            outside.write_text("[]\n")
            link = workspace / "escape.patch.yml"
            link.symlink_to(outside)
            for selected in (outside, link, workspace):
                argv = ["run.py", "--workspace", str(workspace), "--state", directory + "/state", "--model", "local",
                        "--base-url", "http://127.0.0.1:18080/v1", "--search", "off", "--model-patch", str(selected)]
                with self.subTest(path=selected), patch("sys.argv", argv), patch.object(launcher.os, "getuid", return_value=1000), patch.object(launcher, "docker") as docker, patch("sys.stderr"):
                    with self.assertRaises(SystemExit):
                        launcher.main()
                    docker.assert_not_called()


    def test_invalid_runtime_settings_fail_before_docker(self):
        for extra, uid in (
            (["--max-tokens", "262145"], 1000),
            ([], 0),
            (["--approval-file", "/tmp/control-url"], 1000),
            (["--plugin", "unknown"], 1000),
            (["--browser-origin", "http://192.168.1.20:8080"], 1000),
            (["--hermes-acp-volume", "dsh-hermes"], 1000),
            (["--plugin", "dsh-browser", "--profile", "headless"], 1000),
        ):
            argv = ["run.py", "--workspace", "/tmp", "--state", "/tmp/state", "--model", "local",
                    "--base-url", "http://127.0.0.1:18080/v1", "--search", "off", *extra]
            with patch("sys.argv", argv), patch.object(launcher.os, "getuid", return_value=uid), patch.object(launcher, "docker") as docker, patch("sys.stderr"):
                with self.assertRaises(SystemExit):
                    launcher.main()
                docker.assert_not_called()


    def test_host_home_and_its_ancestors_cannot_be_the_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "home"
            home.mkdir()
            for workspace in (home, home.parent):
                argv = ["run.py", "--workspace", str(workspace), "--state", directory + "/state", "--model", "local", "--base-url", "http://127.0.0.1:18080/v1", "--search", "off"]
                with self.subTest(workspace=workspace), patch("sys.argv", argv), patch.object(launcher.Path, "home", return_value=home), patch.object(launcher.os, "getuid", return_value=1000), patch.object(launcher, "docker") as docker, patch("sys.stderr"):
                    with self.assertRaises(SystemExit):
                        launcher.main()
                    docker.assert_not_called()


    def test_host_unix_sockets_fail_before_docker(self):
        for mounted in ("project", "state"):
            with tempfile.TemporaryDirectory() as directory:
                workspace, state = Path(directory) / "project", Path(directory) / "state"
                workspace.mkdir()
                state.mkdir()
                hidden = Path(directory) / mounted / ".ignored"
                hidden.mkdir()
                with socket.socket(socket.AF_UNIX) as host_socket:
                    host_socket.bind(str(hidden / "service.sock"))
                    argv = ["run.py", "--workspace", str(workspace), "--state", str(state),
                            "--model", "local", "--base-url", "http://127.0.0.1:18080/v1", "--search", "off"]
                    with patch("sys.argv", argv), patch.object(launcher.os, "getuid", return_value=1000), patch.object(launcher, "docker") as docker:
                        with self.assertRaisesRegex(ValueError, "Unix sockets"):
                            launcher.main()
                        docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
