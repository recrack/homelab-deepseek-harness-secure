"""Search services reuse only reviewed images and stay on a temporary network."""
import json
from pathlib import Path
import subprocess
from subprocess import CompletedProcess
import tempfile
import unittest

from search_services import (
    SEARCH_CONFIGURATION_LABEL,
    SEARCH_CONFIGURATION_VERSION,
    SEARCH_ENGINE_LABEL,
    SearchServices,
    SOURCES,
    _matches_image,
    _port,
)


class SearchServiceTests(unittest.TestCase):
    def test_reuse_requires_reviewed_digest_configuration_and_expected_port(self):
        searxng = {
            "Config": {
                "Image": SOURCES["searxng"]["upstream_image"],
                "ExposedPorts": {"8080/tcp": {}},
            },
        }
        self.assertFalse(_matches_image(searxng, "searxng"))
        searxng["Config"]["Labels"] = {
            SEARCH_ENGINE_LABEL: "searxng",
            SEARCH_CONFIGURATION_LABEL: SEARCH_CONFIGURATION_VERSION,
        }
        self.assertTrue(_matches_image(searxng, "searxng"))
        self.assertEqual(_port(searxng, "searxng"), 8080)
        searxng["Config"]["Image"] = "searxng/searxng:latest"
        self.assertFalse(_matches_image(searxng, "searxng"))
        searxng["Config"]["ExposedPorts"] = {}
        self.assertIsNone(_port(searxng, "searxng"))

    def test_reuses_dsh_configured_containers_and_detaches_them_at_close(self):
        network = "dsh-offline-run-search"
        services = {
            "searx-id": {
                "Name": "/searx-service",
                "Config": {"Image": SOURCES["searxng"]["upstream_image"], "ExposedPorts": {"8080/tcp": {}}, "Labels": {SEARCH_ENGINE_LABEL: "searxng", SEARCH_CONFIGURATION_LABEL: SEARCH_CONFIGURATION_VERSION}},
                "NetworkSettings": {"Networks": {"existing": {"IPAddress": "172.20.0.4"}}},
            },
            "rust-id": {
                "Name": "/rust-service",
                "Config": {"Image": SOURCES["rustxng"]["upstream_image"], "ExposedPorts": {"29483/tcp": {}}, "Labels": {SEARCH_ENGINE_LABEL: "rustxng", SEARCH_CONFIGURATION_LABEL: SEARCH_CONFIGURATION_VERSION}},
                "NetworkSettings": {"Networks": {"existing": {"IPAddress": "172.20.0.5"}}},
            },
        }
        calls = []

        def docker(*args, capture=False):
            calls.append(args)
            if args[:2] == ("ps", "--quiet"):
                result = "searx-id\nrust-id\n"
            elif args[0] == "inspect":
                if all(value in services for value in args[1:]):
                    result = [services[value] for value in args[1:]]
                else:
                    result = [services["searx-id"] if args[1] == "searx-service" else services["rust-id"]]
            elif args[:2] == ("network", "connect"):
                container = next(item for item in services.values() if item["Name"].lstrip("/") == args[3])
                port = 4 if container["Name"] == "/searx-service" else 5
                container["NetworkSettings"]["Networks"][network] = {"IPAddress": f"172.31.0.{port}"}
                result = ""
            else:
                result = ""
            return CompletedProcess(args, 0, stdout=json.dumps(result) if isinstance(result, (dict, list)) else result, stderr="")

        with tempfile.TemporaryDirectory() as directory:
            manager = SearchServices("dsh-offline-run", Path(directory), "dsh-offline:local", docker=docker)
            endpoints = manager.start()
            self.assertEqual(endpoints["DSH_SEARXNG_URL"], "http://172.31.0.4:8080")
            self.assertEqual(endpoints["DSH_RUSTXNG_URL"], "http://172.31.0.5:29483")
            self.assertEqual(endpoints["DSH_SEARCH_NETWORK"], network)
            self.assertFalse(any(call[:2] == ("build", "--pull=false") for call in calls))
            self.assertTrue(any(call[0] == "run" and "python3" in call for call in calls))
            manager.close()

        detached = [call for call in calls if call[:2] == ("network", "disconnect")]
        self.assertEqual({call[-1] for call in detached}, {"searx-service", "rust-service"})
        self.assertEqual(calls[-1], ("network", "rm", network))

    def test_managed_rustxng_configuration_disables_deepseek_integrations(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = SearchServices("dsh-offline-run", Path(directory), "dsh-offline:local", docker=lambda *_args, **_kwargs: None)
            config = manager._config("rustxng")
            text = config.read_text()
            self.assertIn('provider = "direct"', text)
            self.assertIn("enabled = false", text)
            self.assertIn('name = "deepseek"', text)
            self.assertIn("disabled = true", text)
            self.assertNotIn("api.deepseek.com", text)
            manager.close()

    def test_cached_pinned_upstream_image_is_tagged_without_cloning(self):
        calls = []

        def docker(*args, capture=False):
            calls.append(args)
            if args == ("image", "inspect", SOURCES["rustxng"]["image"]):
                raise subprocess.CalledProcessError(1, args)
            return CompletedProcess(args, 0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as directory:
            manager = SearchServices("dsh-offline-run", Path(directory), "dsh-offline:local", docker=docker)
            manager._clone = lambda _engine: self.fail("A cached pinned image must not clone source")
            manager._image("rustxng")

        self.assertEqual(calls, [
            ("image", "inspect", SOURCES["rustxng"]["image"]),
            ("image", "inspect", SOURCES["rustxng"]["upstream_image"]),
            ("image", "tag", SOURCES["rustxng"]["upstream_image"], SOURCES["rustxng"]["image"]),
        ])

    def test_missing_services_build_pinned_sources_with_restricted_settings(self):
        services = {}
        calls = []

        def docker(*args, capture=False):
            calls.append(args)
            if args[:2] == ("ps", "--quiet"):
                result = ""
            elif args[:2] == ("image", "inspect"):
                raise subprocess.CalledProcessError(1, args)
            elif args[0] == "run" and "--name" in args:
                name = args[args.index("--name") + 1]
                port = 8080 if name.endswith("searxng") else 29483
                labels = {
                    args[index + 1].split("=", 1)[0]: args[index + 1].split("=", 1)[1]
                    for index in range(len(args) - 1)
                    if args[index] == "--label"
                }
                services[name] = {
                    "Name": "/" + name,
                    "Config": {"Image": args[args.index("--mount") + 2], "ExposedPorts": {f"{port}/tcp": {}}, "Labels": labels},
                    "NetworkSettings": {"Networks": {}},
                }
                result = ""
            elif args[:2] == ("network", "connect"):
                container = services[args[3]]
                ip = "172.32.0.4" if args[3].endswith("searxng") else "172.32.0.5"
                container["NetworkSettings"]["Networks"][args[2]] = {"IPAddress": ip}
                result = ""
            elif args[0] == "inspect":
                result = [services[args[1]]]
            else:
                result = ""
            return CompletedProcess(args, 0, stdout=json.dumps(result) if isinstance(result, (dict, list)) else result, stderr="")

        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache"
            source_root = Path(directory) / "sources"
            for engine in SOURCES:
                checkout = source_root / engine
                checkout.mkdir(parents=True)
                manager_dockerfile = checkout / ("container/Dockerfile" if engine == "searxng" else "Dockerfile")
                manager_dockerfile.parent.mkdir(parents=True, exist_ok=True)
                manager_dockerfile.write_text("FROM scratch\n")
            manager = SearchServices("dsh-offline-run", cache, "dsh-offline:local", docker=docker)
            manager._clone = lambda engine: source_root / engine
            endpoints = manager.start()
            self.assertEqual(endpoints["DSH_SEARXNG_URL"], "http://172.32.0.4:8080")
            self.assertEqual(endpoints["DSH_RUSTXNG_URL"], "http://172.32.0.5:29483")
            builds = [call for call in calls if call[0] == "build"]
            self.assertEqual(len(builds), 2)
            starts = [call for call in calls if call[0] == "run" and "--name" in call]
            self.assertEqual(len(starts), 2)
            self.assertTrue(all("--publish" not in call for call in starts))
            self.assertTrue(all("--label" in call for call in starts))
            rust_config = Path(starts[1][starts[1].index("--mount") + 1].split("source=", 1)[1].split(",target=", 1)[0])
            self.assertIn('name = "deepseek"', rust_config.read_text())
            self.assertIn("disabled = true", rust_config.read_text())
            manager.close()
            self.assertTrue(all(not path.exists() for path in manager.configs))


if __name__ == "__main__":
    unittest.main()
