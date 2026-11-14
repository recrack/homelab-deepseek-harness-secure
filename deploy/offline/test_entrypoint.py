"""Exercise firewall initialization and fail-closed paths without host privileges."""

import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest


class EntrypointTests(unittest.TestCase):
    """Use shell command stubs; leave real network enforcement to container checks."""

    def test_initialization_and_rejected_configuration(self):
        with tempfile.TemporaryDirectory(prefix="dsh-entrypoint-check-") as temporary:
            root = Path(temporary)

            def stub(name, body):
                path = root / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o755)

            stub("id", "echo 0")
            stub("iptables-restore", 'cat > "$MOCK_RULES"; [ "${MOCK_FAIL4:-0}" = 0 ]')
            stub("ip6tables-restore", 'cat > "$MOCK_RULES6"; [ "${MOCK_FAIL6:-0}" = 0 ]')
            stub("iptables", '''if [ "$1" = -S ]; then
awk -v chain="$2" 'substr($1,2) == chain {print "-P " chain " " $2} $1 == "-A" && $2 == chain {print}' "$MOCK_RULES"
fi''')
            stub("ip6tables", '''if [ "$1" = -S ] && [ "$2" = INPUT ]; then
printf '%s\\n' '-P INPUT DROP' '-A INPUT -i lo -j ACCEPT'
elif [ "$1" = -S ]; then
printf '%s\\n' '-P OUTPUT DROP' '-A OUTPUT -o lo -j ACCEPT'
fi''')
            stub("getent", "exit 0")
            stub("python3", 'if [ "$1" = - ] && [ -n "${GATEWAY_IP:-}" ]; then script=$(cat); case "$script" in *"from urllib.parse import urlsplit"*) printf "%s\\n" "$script" | "' + sys.executable + '" -;; *) echo 172.30.0.2;; esac; elif [ "$1" = -c ]; then case "$2" in *CapInh*) exit 0;; esac; exec "' + sys.executable + '" "$@"; elif [ "$1" = "$MOCK_PROFILE_INSTALLER" ]; then printf called > "$MOCK_PLUGIN_INSTALL"; printf "%s\\n" "${DSH_OFFLINE_SELECTED_PLUGINS:-[]}"; else exec "' + sys.executable + '" "$@"; fi')
            stub("setpriv", '''printf "%s\\n" "$@" > "$MOCK_DROP"
printf "%s\\n" "$DSH_WEB_HOST" > "$MOCK_WEB_HOST"
while [ "$#" -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done
exec "$@"''')
            stub("node", 'printf "%s\\n" "$@" > "$MOCK_NODE_ARGS"; printf "%s\\n" "$DSH_LOCAL_MODEL_KEY" > "$MOCK_KEY"; printf "%s\\n" "${DSH_COLLECTOR_URL:-}" > "$MOCK_COLLECTOR_URL"; printf "%s\\n" "${DSH_OFFLINE_ACTIVE_PLUGINS:-}" > "$MOCK_ACTIVE_PLUGINS"')
            source = Path(__file__).with_name("entrypoint.sh").read_text()
            profile_installer = root / "profile_plugins.py"
            profile_installer.write_text("# entrypoint test stub\n")
            source = source.replace(
                "/opt/dsh/deploy/offline/profile_plugins.py",
                str(profile_installer),
            )
            script = root / "entrypoint.sh"
            socket_path = root / "agent.sock"
            script.write_text(source.replace("/state", temporary + "/state").replace("/run/hermes-acp/agent.sock", str(socket_path)))
            env = {
                **os.environ,
                "PATH": temporary + ":" + os.environ["PATH"],
                "MODEL_GATEWAY_HOST": "172.30.0.1",
                "MODEL_GATEWAY_PORT": "18089",
                "DSH_MODEL_ID": "test",
                "DSH_UID": "1000",
                "DSH_WORKSPACE": temporary,
                "DSH_GID": "1000",
                "MOCK_RULES": str(root / "rules"),
                "MOCK_RULES6": str(root / "rules6"),
                "MOCK_DROP": str(root / "drop"),
                "MOCK_WEB_HOST": str(root / "web-host"),
                "MOCK_NODE_ARGS": str(root / "node-args"),
                "MOCK_KEY": str(root / "key"),
                "MOCK_COLLECTOR_URL": str(root / "collector-url"),
                "MOCK_ACTIVE_PLUGINS": str(root / "active-plugins"),
                "MOCK_PROFILE_INSTALLER": str(profile_installer),
                "MOCK_PLUGIN_INSTALL": str(root / "plugin-install"),
                "DSH_COLLECTOR_HOST": "",
                "DSH_HERMES_ACP_ENABLED": "0",
                "DSH_WEB_PORT": "3080",
                "DSH_BROWSER_ALLOWED_ORIGINS": "[]",
                "DSH_OFFLINE_SELECTED_PLUGINS": "[]",
            }

            def run(overrides, profile="headless"):
                return subprocess.run(
                    ["sh", str(script), profile, "test task"],
                    env={**env, **overrides}, capture_output=True, text=True,
                )

            result = run({})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(":OUTPUT DROP", (root / "rules").read_text())
            self.assertIn(":INPUT DROP", (root / "rules").read_text())
            self.assertIn("-d 127.0.0.11/32 -j DROP", (root / "rules").read_text())
            self.assertNotIn("192.168.", (root / "rules").read_text())
            self.assertNotIn(":INPUT ACCEPT", (root / "rules").read_text())
            self.assertNotEqual((root / "web-host").read_text().strip(), "0.0.0.0")
            for option in ("--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--clear-groups"):
                self.assertIn(option, (root / "drop").read_text())
            args = (root / "node-args").read_text().splitlines()
            self.assertEqual((root / "key").read_text().strip(), "local")
            self.assertNotIn("/opt/dsh/deploy/offline/web.patch.yml", args)
            self.assertEqual(args[-1], "test task")
            self.assertFalse((root / "plugin-install").exists())
            headless_rules = (root / "rules").read_text()
            self.assertNotIn("--dport 3080", headless_rules)
            result = run({}, "web")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "plugin-install").read_text(), "called")
            self.assertEqual((root / "active-plugins").read_text().strip(), "[]")
            args = (root / "node-args").read_text().splitlines()
            self.assertEqual(args[-5:], ["--patch", "/opt/dsh/deploy/offline/web.patch.yml", "--patch", temporary + "/state/tmp/offline-presets.patch.yml", "test task"])
            self.assertEqual(args.count("--patch"), 3)
            self.assertIn("-A INPUT -p tcp --dport 3080", (root / "rules").read_text())
            self.assertEqual((root / "collector-url").read_text().strip(), "")
            result = run({"DSH_COLLECTOR_HOST": "172.30.0.3"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "collector-url").read_text().strip(), "http://172.30.0.3:8080")
            self.assertIn("-d 172.30.0.3/32 -p tcp --dport 8080", (root / "rules").read_text())
            result = run({"DSH_BROWSER_ALLOWED_ORIGINS": '["http://192.168.44.12:4173"]'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("-d 192.168.44.12/32 -p tcp --dport 4173", (root / "rules").read_text())
            self.assertIn(":INPUT DROP", (root / "rules6").read_text())
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as hermes_socket:
                hermes_socket.bind(str(socket_path))
                result = run({"DSH_HERMES_ACP_ENABLED": "1", "DSH_OFFLINE_SELECTED_PLUGINS": '["dsh-crew"]'}, "web")
            socket_path.unlink()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("/opt/dsh/deploy/offline/hermes.patch.yml", (root / "node-args").read_text())
            for rejected in (
                {"MOCK_FAIL4": "1"}, {"MOCK_FAIL6": "1"}, {"DSH_UID": "0"},
                {"MODEL_GATEWAY_PORT": "1 -j ACCEPT"},
                {"MODEL_GATEWAY_HOST": "example.com"},
                {"MODEL_GATEWAY_HOST": "8.8.8.8"},
                {"MODEL_GATEWAY_HOST": "169.254.169.254"},
                {"DSH_COLLECTOR_HOST": "8.8.8.8"},
                {"DSH_COLLECTOR_HOST": "127.0.0.11"},
                {"DSH_COLLECTOR_HOST": "172.30.0.3", "DSH_COLLECTOR_PORT": "8080 -j ACCEPT"},
                {"DSH_BROWSER_ALLOWED_ORIGINS": '["https://example.com"]'},
                {"DSH_BROWSER_ALLOWED_ORIGINS": '["http://192.168.1.2:0"]'},
            ):
                with self.subTest(rejected=rejected):
                    (root / "drop").unlink(missing_ok=True)
                    self.assertNotEqual(run(rejected).returncode, 0)
                    self.assertFalse((root / "drop").exists())

            for rejected in ({"DSH_HERMES_ACP_ENABLED": "true"}, {"DSH_HERMES_ACP_ENABLED": "1"}):
                with self.subTest(rejected=rejected):
                    self.assertNotEqual(run(rejected).returncode, 0)
                    self.assertFalse((root / "drop").exists())


if __name__ == "__main__":
    unittest.main()
