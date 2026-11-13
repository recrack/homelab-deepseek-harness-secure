"""Install bundled offline plugins into the persistent Web profile."""
import json
import os
from pathlib import Path
import tempfile


BASE_BUNDLES = ("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app")
PLUGIN_DEPENDENCIES = {
    "dsh-context": "file:/opt/dsh/deploy/offline/plugins/dsh-context",
    "dsh-claude-artifacts": "file:/opt/dsh/deploy/offline/plugins/dsh-claude-artifacts",
    "dsh-claude-design": "file:/opt/dsh/deploy/offline/plugins/dsh-claude-design",
    "@zseven-w/dsh-crew": "file:/opt/dsh-deps/dsh-crew",
}
PLUGIN_ROOTS = {name: Path(spec.removeprefix("file:")) for name, spec in PLUGIN_DEPENDENCIES.items()}
PLUGIN_BUNDLES = tuple(PLUGIN_DEPENDENCIES)
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


def install_plugin_links(profile_dir, plugin_roots):
    """Expose the bundled package roots at the profile's dependency paths."""
    modules_dir = Path(profile_dir) / "node_modules"
    for name in PLUGIN_BUNDLES:
        target = Path(plugin_roots[name])
        if not target.is_dir():
            raise ValueError(f"bundled plugin package is missing for {name}: {target}")
        target = target.resolve(strict=True)
        link = modules_dir.joinpath(*name.split("/"))
        link.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if link.is_symlink() and link.resolve(strict=False) == target:
            continue
        if os.path.lexists(link) and not link.is_symlink():
            raise ValueError(f"profile plugin path is occupied by a non-symlink for {name}: {link}")

        descriptor, temporary = tempfile.mkstemp(prefix="." + link.name + ".", dir=link.parent)
        os.close(descriptor)
        temporary_path = Path(temporary)
        temporary_path.unlink()
        try:
            temporary_path.symlink_to(target, target_is_directory=True)
            os.replace(temporary_path, link)
        finally:
            temporary_path.unlink(missing_ok=True)


def install_profile(dsh_home, home, model_id, hermes_enabled, plugin_roots=None):
    """Add local bundles and safe dsh-crew defaults without replacing user layers."""
    if not model_id:
        raise ValueError("DSH_MODEL_ID is required")
    plugin_roots = PLUGIN_ROOTS if plugin_roots is None else plugin_roots
    for name in PLUGIN_BUNDLES:
        if name not in plugin_roots or not Path(plugin_roots[name]).is_dir():
            raise ValueError(f"bundled plugin package is missing for {name}: {plugin_roots.get(name, '<unset>')}")

    profile_dir = Path(dsh_home) / "profiles" / "web"
    profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest_path = profile_dir / "package.json"
    manifest = read_object(manifest_path)
    manifest.setdefault("name", "dsh-profile-web")
    manifest.setdefault("private", True)

    dependencies = manifest.setdefault("dependencies", {})
    if not isinstance(dependencies, dict):
        raise ValueError(f"dependencies must be an object in {manifest_path}")
    for name, spec in PLUGIN_DEPENDENCIES.items():
        dependencies[name] = spec

    dsh = manifest.setdefault("dsh", {})
    if not isinstance(dsh, dict):
        raise ValueError(f"dsh must be an object in {manifest_path}")
    profile = dsh.setdefault("profile", {})
    if not isinstance(profile, dict):
        raise ValueError(f"dsh.profile must be an object in {manifest_path}")
    bundles = profile.setdefault("bundles", [])
    if not isinstance(bundles, list) or any(not isinstance(name, str) for name in bundles):
        raise ValueError(f"dsh.profile.bundles must be a string array in {manifest_path}")
    for name in BASE_BUNDLES:
        if name not in bundles:
            bundles.insert(0 if name == BASE_BUNDLES[0] else 1, name)
    for name in PLUGIN_BUNDLES:
        if name not in bundles:
            bundles.append(name)

    if not manifest_path.exists() or read_object(manifest_path) != manifest:
        write_json(manifest_path, manifest)
    install_plugin_links(profile_dir, plugin_roots)
    patch_path = profile_dir / "cordis.patch.yml"
    if not patch_path.exists():
        patch_path.write_text(PROFILE_PATCH, encoding="utf-8")
    workspace_path = profile_dir / "pnpm-workspace.yaml"
    if not workspace_path.exists():
        workspace_path.write_text(PROFILE_PNPM_WORKSPACE, encoding="utf-8")

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


def main():
    dsh_home = os.environ.get("DSH_HOME")
    home = os.environ.get("HOME")
    if not dsh_home or not home:
        raise SystemExit("dsh offline: HOME and DSH_HOME are required to install Web plugins")
    try:
        install_profile(dsh_home, home, os.environ.get("DSH_MODEL_ID", ""), os.environ.get("DSH_HERMES_ACP_ENABLED") == "1")
    except (OSError, ValueError) as error:
        raise SystemExit("dsh offline: could not install Web plugin profile: " + str(error)) from error


if __name__ == "__main__":
    main()
