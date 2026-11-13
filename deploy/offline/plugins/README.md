# Offline DSH plugins

English | [中文](README.zh.md)

The Web deployment uses these plugin packages from inside the image; it does not read `/home/pigma/dsh-private-validation` at runtime.

- `dsh-context` 0.83.0 is the staged package from `bowenliang123/dsh-context`; its local-only patch blocks the catalog, balance, and recommendation requests and replaces the remote fallback icon.
- `dsh-claude-artifacts` and `dsh-claude-design` are the package snapshots selected in the private validation profile; retain each `LICENSE` and `NOTICE.md` with its package.
- `@zseven-w/dsh-crew` is fetched from the pinned source commit in the offline Dockerfile and installed with its production dependencies.

The profile installer selects `dsh-context`, `dsh-claude-artifacts`, `dsh-claude-design`, and `@zseven-w/dsh-crew` for the persistent Web profile. The Hermes ACP preset is selected for DSH Crew workers only when an ACP volume is mounted. Otherwise, both worker tiers use the configured local model. Vision and image generation providers are disabled, and worker dispatch requires the running DSH hub.
