"""Tests for explicit and persistent offline Web plugin selection."""
import json
from pathlib import Path
import tempfile
import unittest

from profile_plugins import PLUGIN_DEPENDENCIES, PLUGIN_PACKAGES, install_profile, selected_plugin_ids


class ProfilePluginsTests(unittest.TestCase):
    """Keep plugin selection local to the requested persistent profile."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.dsh_home = self.root / ".dsh"
        self.home = self.root / "home"
        self.plugin_roots = {
            package: self.root / "bundled" / package.rsplit("/", 1)[-1]
            for package in PLUGIN_PACKAGES.values()
        }
        for path in self.plugin_roots.values():
            path.mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def test_no_optional_plugin_is_installed_by_default(self):
        active = install_profile(self.dsh_home, self.home, "qwen-local", False, plugin_roots=self.plugin_roots)

        profile = json.loads((self.dsh_home / "profiles/web/package.json").read_text())
        self.assertEqual(active, [])
        self.assertEqual(profile["dsh"]["profile"]["bundles"], ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        self.assertEqual(profile["dependencies"], {})
        self.assertFalse((self.dsh_home / "profiles/web/node_modules").exists())
        self.assertFalse((self.home / ".config/dsh-crew/config.json").exists())

    def test_selected_plugins_install_once_and_configure_crew_safely(self):
        selected = list(PLUGIN_PACKAGES)
        active = install_profile(self.dsh_home, self.home, "qwen-local", True, selected, self.plugin_roots)

        profile = json.loads((self.dsh_home / "profiles/web/package.json").read_text())
        self.assertEqual(active, selected)
        self.assertEqual(
            profile["dsh"]["profile"]["bundles"],
            [
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "dsh-context",
                "dsh-claude-artifacts",
                "dsh-claude-slides",
                "dsh-claude-design",
                "dsh-claude-design-system",
                "dsh-claude-data",
                "dsh-claude-motion",
                "dsh-claude-whiteboard",
                "@zseven-w/dsh-crew",
            ],
        )
        self.assertEqual(profile["dependencies"], PLUGIN_DEPENDENCIES)
        for package, target in self.plugin_roots.items():
            link = self.dsh_home / "profiles/web/node_modules" / package
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.resolve(), target.resolve())
        crew = json.loads((self.home / ".config/dsh-crew/config.json").read_text())
        self.assertEqual(crew["mode"], "hub")
        self.assertEqual(crew["flash_provider"], "local-private")
        self.assertEqual(crew["flash_model"], "qwen-local")
        self.assertEqual(crew["vision_provider"], "off")
        self.assertEqual(crew["imagegen_provider"], "off")
        self.assertEqual(crew["preset_flash"], "hermes-qwen")

    def test_selected_plugins_remain_active_and_custom_profile_data_survives(self):
        profile_dir = self.dsh_home / "profiles/web"
        profile_dir.mkdir(parents=True)
        (profile_dir / "package.json").write_text(json.dumps({
            "name": "custom-web",
            "private": True,
            "dependencies": {"existing-plugin": "1.0.0"},
            "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "custom-bundle"]}},
        }))
        (profile_dir / "cordis.patch.yml").write_text("- id: custom-entry\n  disabled: true\n")
        config_path = self.home / ".config/dsh-crew/config.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(json.dumps({"locale": "ko", "custom_providers": [{"id": "local"}]}))

        selected = install_profile(self.dsh_home, self.home, "qwen-local", True, ("dsh-context", "dsh-crew"), self.plugin_roots)
        persisted = install_profile(self.dsh_home, self.home, "qwen-local", False, plugin_roots=self.plugin_roots)

        profile = json.loads((profile_dir / "package.json").read_text())
        self.assertEqual(selected, ["dsh-context", "dsh-crew"])
        self.assertEqual(persisted, selected)
        self.assertEqual(profile["name"], "custom-web")
        self.assertEqual(profile["dependencies"]["existing-plugin"], "1.0.0")
        self.assertIn("custom-bundle", profile["dsh"]["profile"]["bundles"])
        self.assertEqual(profile["dsh"]["profile"]["bundles"].count("dsh-context"), 1)
        self.assertEqual((profile_dir / "cordis.patch.yml").read_text(), "- id: custom-entry\n  disabled: true\n")
        crew = json.loads(config_path.read_text())
        self.assertEqual(crew["locale"], "ko")
        self.assertEqual(crew["custom_providers"], [{"id": "local"}])
        self.assertEqual(crew["mode"], "hub")
        self.assertEqual(crew["preset_flash"], "default")

    def test_migrates_legacy_plugin_paths_without_dropping_bundles(self):
        profile_dir = self.dsh_home / "profiles/web"
        profile_dir.mkdir(parents=True)
        (profile_dir / "package.json").write_text(json.dumps({
            "dependencies": {"dsh-context": "file:/opt/dsh/deploy/offline/plugins/dsh-context"},
            "dsh": {"profile": {"bundles": ["dsh-context"]}},
        }))

        active = install_profile(self.dsh_home, self.home, "qwen-local", False, plugin_roots=self.plugin_roots)

        profile = json.loads((profile_dir / "package.json").read_text())
        self.assertEqual(active, ["dsh-context"])
        self.assertEqual(profile["dependencies"]["dsh-context"], PLUGIN_DEPENDENCIES["dsh-context"])
        self.assertIn("dsh-context", profile["dsh"]["profile"]["bundles"])

    def test_design_selection_installs_its_artifacts_dependency_without_activating_its_bundle(self):
        active = install_profile(self.dsh_home, self.home, "qwen-local", False, ("dsh-claude-design",), self.plugin_roots)

        profile = json.loads((self.dsh_home / "profiles/web/package.json").read_text())
        bundles = profile["dsh"]["profile"]["bundles"]
        self.assertEqual(active, ["dsh-claude-design"])
        self.assertIn("dsh-claude-design", bundles)
        self.assertNotIn("dsh-claude-artifacts", bundles)
        self.assertEqual(profile["dependencies"]["dsh-claude-artifacts"], PLUGIN_DEPENDENCIES["dsh-claude-artifacts"])
        self.assertTrue((self.dsh_home / "profiles/web/node_modules/dsh-claude-artifacts").is_symlink())

    def test_open_artifacts_features_install_the_shared_package_without_its_standalone_bundle(self):
        features = (
            "dsh-claude-slides",
            "dsh-claude-design",
            "dsh-claude-design-system",
            "dsh-claude-data",
            "dsh-claude-motion",
            "dsh-claude-whiteboard",
        )
        for plugin_id in features:
            with self.subTest(plugin_id=plugin_id):
                dsh_home = self.root / plugin_id / ".dsh"
                home = self.root / plugin_id / "home"
                active = install_profile(dsh_home, home, "qwen-local", False, (plugin_id,), self.plugin_roots)
                profile = json.loads((dsh_home / "profiles/web/package.json").read_text())
                bundles = profile["dsh"]["profile"]["bundles"]
                self.assertEqual(active, [plugin_id])
                self.assertIn(plugin_id, bundles)
                self.assertNotIn("dsh-claude-artifacts", bundles)
                self.assertEqual(
                    profile["dependencies"]["dsh-claude-artifacts"],
                    PLUGIN_DEPENDENCIES["dsh-claude-artifacts"],
                )
                self.assertTrue((dsh_home / "profiles/web/node_modules/dsh-claude-artifacts").is_symlink())

    def test_refuses_hermes_without_an_active_crew_plugin(self):
        with self.assertRaisesRegex(ValueError, "Hermes ACP requires the dsh-crew plugin"):
            install_profile(self.dsh_home, self.home, "qwen-local", True, plugin_roots=self.plugin_roots)

    def test_refuses_to_replace_a_non_symlink_plugin_path(self):
        link = self.dsh_home / "profiles/web/node_modules/dsh-context"
        link.mkdir(parents=True)

        with self.assertRaisesRegex(ValueError, "occupied by a non-symlink for dsh-context"):
            install_profile(self.dsh_home, self.home, "qwen-local", False, ("dsh-context",), self.plugin_roots)

        self.assertTrue(link.is_dir())
        self.assertFalse(link.is_symlink())

    def test_validates_the_host_plugin_selection(self):
        self.assertEqual(selected_plugin_ids('["dsh-browser"]'), ["dsh-browser"])
        self.assertEqual(selected_plugin_ids('["dsh-claude-slides"]'), ["dsh-claude-slides"])
        for invalid in ("{}", '["unknown"]', '["dsh-browser","dsh-browser"]', "[1]"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                selected_plugin_ids(invalid)


if __name__ == "__main__":
    unittest.main()
