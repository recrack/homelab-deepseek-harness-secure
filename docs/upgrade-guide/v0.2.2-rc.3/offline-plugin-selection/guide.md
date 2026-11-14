---
kind: upgrade-guide
description: "Offline plugins now require explicit selection instead of automatic installation into every new Web profile."
---
# Offline plugins require explicit selection

## Change

The offline launcher used to add `dsh-context`, both Baoyu plugins, and DSH Crew to every new Web profile, and it mounted `dsh-browser` in every Web preset. It now installs and activates optional plugins only when selected with the repeatable `--plugin <id>` option. The choices are stored in the persistent Web profile, so a selected plugin stays active on later launches. Existing profiles keep their installed bundle selections. The browser must be selected on each launch that uses `--browser-origin`; Hermes ACP requires selecting `dsh-crew` on each launch that passes `--hermes-acp-volume`.

The image fetches the pinned [homelab-dsh-plugins](https://github.com/recrack/homelab-dsh-plugins) revision during its build. It does not clone plugin sources when DSH starts.

## Migration

1. Rebuild the image from the repository root with `docker build --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) -f deploy/offline/Dockerfile -t dsh-offline:local .`.
2. Add one `--plugin <id>` option for every plugin needed in a new state directory. Available IDs are `dsh-browser`, `dsh-context`, `dsh-claude-artifacts`, `dsh-claude-design`, and `dsh-crew`. Repeat the option to select more than one plugin.
3. When using browser navigation, include `--plugin dsh-browser` and the exact private `--browser-origin` options in that launch. When using Hermes ACP, include `--plugin dsh-crew` with `--hermes-acp-volume`.
4. Keep the same `--state` directory to retain its profile. Run `python3 deploy/offline/run.py --help` to confirm the launcher exposes `--plugin`.
