"""Install explicitly selected offline plugins into the persistent Web profile."""
import json
import os
from pathlib import Path
import tempfile


BASE_BUNDLES = ("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-family-account")
BASE_PLUGIN_PACKAGES = {"dsh-family-account": "dsh-family-account"}
BASE_PLUGIN_BUNDLE_NAMES = {"dsh-family-account": "dsh-family-account"}
OPEN_ARTIFACTS_PLUGIN_IDS = (
    "dsh-claude-artifacts",
    "dsh-claude-slides",
    "dsh-claude-design",
    "dsh-claude-design-system",
    "dsh-claude-data",
    "dsh-claude-motion",
    "dsh-claude-whiteboard",
)
OPEN_ARTIFACTS_PACKAGES = frozenset(OPEN_ARTIFACTS_PLUGIN_IDS)
PLUGIN_PACKAGES = {
    "dsh-browser": "@zseven-w/dsh-browser",
    "dsh-context": "dsh-context",
    "dsh-super-kanban": "dsh-super-kanban",
    "dsh-claude-artifacts": "dsh-claude-artifacts",
    "dsh-claude-slides": "dsh-claude-slides",
    "dsh-claude-design": "dsh-claude-design",
    "dsh-claude-design-system": "dsh-claude-design-system",
    "dsh-claude-data": "dsh-claude-data",
    "dsh-claude-motion": "dsh-claude-motion",
    "dsh-claude-whiteboard": "dsh-claude-whiteboard",
    "dsh-crew": "@zseven-w/dsh-crew",
}
ALL_PLUGIN_PACKAGES = {**BASE_PLUGIN_PACKAGES, **PLUGIN_PACKAGES}
PLUGIN_BUNDLE_NAMES = {
    "dsh-context": "dsh-context",
    "dsh-super-kanban": "dsh-super-kanban",
    "dsh-claude-artifacts": "dsh-claude-artifacts",
    "dsh-claude-slides": "dsh-claude-slides",
    "dsh-claude-design": "dsh-claude-design",
    "dsh-claude-design-system": "dsh-claude-design-system",
    "dsh-claude-data": "dsh-claude-data",
    "dsh-claude-motion": "dsh-claude-motion",
    "dsh-claude-whiteboard": "dsh-claude-whiteboard",
    "dsh-crew": "@zseven-w/dsh-crew",
}
ALL_PLUGIN_BUNDLE_NAMES = {**BASE_PLUGIN_BUNDLE_NAMES, **PLUGIN_BUNDLE_NAMES}
PLUGIN_RUNTIME_DEPENDENCIES = {
    plugin_id: ("dsh-claude-artifacts",)
    for plugin_id in OPEN_ARTIFACTS_PLUGIN_IDS
    if plugin_id != "dsh-claude-artifacts"
}
PLUGIN_DEPENDENCIES = {
    package: (
        f"file:/opt/homelab-dsh-plugins/packages/open-artifacts/generated/{package}"
        if package in OPEN_ARTIFACTS_PACKAGES
        else f"file:/opt/homelab-dsh-plugins/packages/{package.rsplit('/', 1)[-1]}"
    )
    for package in ALL_PLUGIN_PACKAGES.values()
}
LEGACY_PLUGIN_DEPENDENCIES = {
    "dsh-context": "file:/opt/dsh/deploy/offline/plugins/dsh-context",
    "dsh-claude-artifacts": "file:/opt/homelab-dsh-plugins/packages/dsh-claude-artifacts",
    "dsh-claude-design": "file:/opt/homelab-dsh-plugins/packages/dsh-claude-design",
    "@zseven-w/dsh-crew": "file:/opt/dsh-deps/dsh-crew",
}
PLUGIN_ROOTS = {
    package: (
        Path("/opt/homelab-dsh-plugins/packages/open-artifacts/generated") / package
        if package in OPEN_ARTIFACTS_PACKAGES
        else Path("/opt/homelab-dsh-plugins/packages") / package.rsplit("/", 1)[-1]
    )
    for package in ALL_PLUGIN_PACKAGES.values()
}
PROFILE_PATCH = """# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
"""
PROFILE_PNPM_WORKSPACE = """packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
"""


def read_object(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON in {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return value


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def selected_plugin_ids(value):
    """Validate the JSON plugin selection received from the host launcher."""
    try:
        selected = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError("selected plugins must be a JSON string array") from error
    if not isinstance(selected, list) or any(not isinstance(plugin, str) for plugin in selected):
        raise ValueError("selected plugins must be a JSON string array")
    if len(set(selected)) != len(selected):
        raise ValueError("selected plugins must not contain duplicates")
    unknown = set(selected) - PLUGIN_PACKAGES.keys()
    if unknown:
        raise ValueError("unknown selected plugin id: " + ", ".join(sorted(unknown)))
    return selected


def install_plugin_links(profile_dir, active_plugins, plugin_roots):
    """Expose active package roots at the persistent profile's dependency paths."""
    modules_dir = Path(profile_dir) / "node_modules"
    package_ids = {package: plugin_id for plugin_id, package in ALL_PLUGIN_PACKAGES.items()}
    for name in active_plugins:
        plugin_id = package_ids[name]
        target = Path(plugin_roots[name])
        if not target.is_dir():
            raise ValueError(f"plugin package is missing for {plugin_id}: {target}")
        target = target.resolve(strict=True)
        link = modules_dir.joinpath(*name.split("/"))
        link.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if link.is_symlink() and link.resolve(strict=False) == target:
            continue
        if os.path.lexists(link) and not link.is_symlink():
            raise ValueError(f"profile plugin path is occupied by a non-symlink for {plugin_id}: {link}")

        descriptor, temporary = tempfile.mkstemp(prefix="." + link.name + ".", dir=link.parent)
        os.close(descriptor)
        temporary_path = Path(temporary)
        temporary_path.unlink()
        try:
            temporary_path.symlink_to(target, target_is_directory=True)
            os.replace(temporary_path, link)
        finally:
            temporary_path.unlink(missing_ok=True)


def install_profile(dsh_home, home, model_id, hermes_enabled, selected_plugins=(), plugin_roots=None):
    """Add selected local bundles while preserving profile layers and existing selections."""
    if not model_id:
        raise ValueError("DSH_MODEL_ID is required")
    selected = list(selected_plugins)
    if any(plugin not in PLUGIN_PACKAGES for plugin in selected) or len(set(selected)) != len(selected):
        raise ValueError("selected plugins must be known unique plugin ids")
    plugin_roots = PLUGIN_ROOTS if plugin_roots is None else plugin_roots

    profile_dir = Path(dsh_home) / "profiles" / "web"
    profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest_path = profile_dir / "package.json"
    manifest = read_object(manifest_path)
    manifest.setdefault("name", "dsh-profile-web")
    manifest.setdefault("private", True)

    dependencies = manifest.setdefault("dependencies", {})
    if not isinstance(dependencies, dict):
        raise ValueError(f"dependencies must be an object in {manifest_path}")
    dsh = manifest.setdefault("dsh", {})
    if not isinstance(dsh, dict):
        raise ValueError(f"dsh must be an object in {manifest_path}")
    profile = dsh.setdefault("profile", {})
    if not isinstance(profile, dict):
        raise ValueError(f"dsh.profile must be an object in {manifest_path}")
    bundles = profile.setdefault("bundles", [])
    if not isinstance(bundles, list) or any(not isinstance(name, str) for name in bundles):
        raise ValueError(f"dsh.profile.bundles must be a string array in {manifest_path}")
    for index, name in enumerate(BASE_BUNDLES):
        if name not in bundles:
            bundles.insert(index, name)

    active = set(selected)
    active_package_names = set()
    for plugin_id, package in ALL_PLUGIN_PACKAGES.items():
        spec = PLUGIN_DEPENDENCIES[package]
        legacy_spec = LEGACY_PLUGIN_DEPENDENCIES.get(package)
        bundle_name = ALL_PLUGIN_BUNDLE_NAMES.get(plugin_id)
        was_bundled = bundle_name is not None and bundle_name in bundles
        existing_spec = dependencies.get(package)
        was_installed = existing_spec == spec or (legacy_spec is not None and existing_spec == legacy_spec)
        if plugin_id in active or was_bundled or (bundle_name is None and was_installed):
            active.add(plugin_id)
        if plugin_id in selected and bundle_name is not None and bundle_name not in bundles:
            bundles.append(bundle_name)

    if hermes_enabled and "dsh-crew" not in active:
        raise ValueError("Hermes ACP requires the dsh-crew plugin")
    for plugin_id in active:
        active_package_names.add(ALL_PLUGIN_PACKAGES[plugin_id])
        for dependency_id in PLUGIN_RUNTIME_DEPENDENCIES.get(plugin_id, ()):
            active_package_names.add(ALL_PLUGIN_PACKAGES[dependency_id])
    for package in active_package_names:
        dependencies[package] = PLUGIN_DEPENDENCIES[package]
    for name in active_package_names:
        if name not in plugin_roots or not Path(plugin_roots[name]).is_dir():
            raise ValueError(f"plugin package is missing for {name}: {plugin_roots.get(name, '<unset>')}")
    if not manifest_path.exists() or read_object(manifest_path) != manifest:
        write_json(manifest_path, manifest)
    active_plugins = [plugin_id for plugin_id in PLUGIN_PACKAGES if plugin_id in active]
    install_plugin_links(profile_dir, active_package_names, plugin_roots)

    patch_path = profile_dir / "cordis.patch.yml"
    if not patch_path.exists():
        patch_path.write_text(PROFILE_PATCH, encoding="utf-8")
    workspace_path = profile_dir / "pnpm-workspace.yaml"
    if not workspace_path.exists():
        workspace_path.write_text(PROFILE_PNPM_WORKSPACE, encoding="utf-8")

    if "dsh-crew" in active:
        crew_config_path = Path(home) / ".config" / "dsh-crew" / "config.json"
        crew_config = read_object(crew_config_path)
        safe_defaults = {
            "mode": "hub",
            "hub_url": "http://127.0.0.1:3080",
            "flash_provider": "local-private",
            "flash_model": model_id,
            "pro_provider": "local-private",
            "pro_model": model_id,
            "preset_flash": "hermes-qwen" if hermes_enabled else "default",
            "preset_pro": "hermes-qwen" if hermes_enabled else "default",
            "vision_provider": "off",
            "imagegen_provider": "off",
        }
        next_config = {**crew_config, **safe_defaults}
        if not crew_config_path.exists() or next_config != crew_config:
            write_json(crew_config_path, next_config)

    return active_plugins


def main():
    dsh_home = os.environ.get("DSH_HOME")
    home = os.environ.get("HOME")
    if not dsh_home or not home:
        raise SystemExit("dsh offline: HOME and DSH_HOME are required to prepare the Web profile")
    try:
        selected = selected_plugin_ids(os.environ.get("DSH_OFFLINE_SELECTED_PLUGINS", "[]"))
        active = install_profile(
            dsh_home,
            home,
            os.environ.get("DSH_MODEL_ID", ""),
            os.environ.get("DSH_HERMES_ACP_ENABLED") == "1",
            selected,
        )
    except (OSError, ValueError) as error:
        raise SystemExit("dsh offline: could not prepare the Web plugin profile: " + str(error)) from error
    print(json.dumps(active))


if __name__ == "__main__":
    main()
