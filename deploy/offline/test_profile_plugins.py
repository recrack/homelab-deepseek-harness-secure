"""Tests for the persistent offline Web profile setup."""
import json
from pathlib import Path
import tempfile
import unittest

from profile_plugins import PLUGIN_BUNDLES, PLUGIN_DEPENDENCIES, install_profile


class ProfilePluginsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.dsh_home = self.root / ".dsh"
        self.home = self.root / "home"
        self.plugin_roots = {name: self.root / "bundled" / name for name in PLUGIN_BUNDLES}
        for path in self.plugin_roots.values():
            path.mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def test_installs_plugin_bundles_and_local_crew_defaults(self):
        install_profile(self.dsh_home, self.home, "qwen-local", False, self.plugin_roots)

        profile = json.loads((self.dsh_home / "profiles/web/package.json").read_text())
        self.assertEqual(profile["dsh"]["profile"]["bundles"][:2], ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        self.assertEqual(profile["dsh"]["profile"]["bundles"][2:], list(PLUGIN_BUNDLES))
        self.assertEqual(profile["dependencies"], PLUGIN_DEPENDENCIES)
        for name, target in self.plugin_roots.items():
            link = self.dsh_home / "profiles/web/node_modules" / name
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.resolve(), target.resolve())
        crew = json.loads((self.home / ".config/dsh-crew/config.json").read_text())
        self.assertEqual(crew["mode"], "hub")
        self.assertEqual(crew["flash_provider"], "local-private")
        self.assertEqual(crew["flash_model"], "qwen-local")
        self.assertEqual(crew["vision_provider"], "off")
        self.assertEqual(crew["imagegen_provider"], "off")
        self.assertEqual(crew["preset_flash"], "default")

    def test_preserves_profile_layers_and_crew_preferences(self):
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

        install_profile(self.dsh_home, self.home, "qwen-local", True, self.plugin_roots)
        install_profile(self.dsh_home, self.home, "qwen-local", True, self.plugin_roots)

        profile = json.loads((profile_dir / "package.json").read_text())
        self.assertEqual(profile["name"], "custom-web")
        self.assertEqual(profile["dependencies"]["existing-plugin"], "1.0.0")
        self.assertIn("custom-bundle", profile["dsh"]["profile"]["bundles"])
        self.assertEqual(profile["dsh"]["profile"]["bundles"].count("dsh-context"), 1)
        self.assertEqual((profile_dir / "cordis.patch.yml").read_text(), "- id: custom-entry\n  disabled: true\n")
        crew = json.loads(config_path.read_text())
        self.assertEqual(crew["locale"], "ko")
        self.assertEqual(crew["custom_providers"], [{"id": "local"}])
        self.assertEqual(crew["mode"], "hub")
        self.assertEqual(crew["preset_flash"], "hermes-qwen")
        self.assertEqual(crew["preset_pro"], "hermes-qwen")

    def test_refuses_to_replace_a_non_symlink_plugin_path(self):
        link = self.dsh_home / "profiles/web/node_modules/dsh-context"
        link.mkdir(parents=True)

        with self.assertRaisesRegex(ValueError, "occupied by a non-symlink for dsh-context"):
            install_profile(self.dsh_home, self.home, "qwen-local", False, self.plugin_roots)

        self.assertTrue(link.is_dir())
        self.assertFalse(link.is_symlink())


if __name__ == "__main__":
    unittest.main()
