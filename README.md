# Homelab DeepSeek Harness Secure

English | [한국어](README.ko.md)

This repository packages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for a local-model deployment with controlled web access. The [deployment guide](deploy/offline/README.md) owns build, launch, and operating details.

## Architecture and stacks

The deployment separates the DSH agent from model relay, approved public retrieval, and search services. The DSH agent has no direct public network route. Search and page retrieval can reach public services only through their separate components after the user approves the exact query or URL.

| Component | Stack | Role |
| --- | --- | --- |
| Host launcher and model relay | Python 3 standard library, Docker CLI | Validates the selected private IPv4 model endpoint, starts a route-limited relay, and manages per-run containers and networks. |
| DSH agent | Node.js 24 on Debian Bookworm, pnpm 11.28.5, TypeScript/ESM, Cordis | Runs the Web or headless profile with telemetry, account providers, and remote session logging disabled by the deployment overlay. |
| Network enforcement | Linux `iptables`, `ip6tables`, `setpriv` | Applies default-deny rules before DSH loads, blocks Docker DNS, and removes Linux capabilities from the agent process. |
| Approved web collector | Separate Node.js ESM container and the DSH `public-web` profile | Shows each search query or fetch URL for local approval, then forwards only that approved request. It has no workspace or Session mount. |
| Search engines | [SearXNG](https://github.com/searxng/searxng) in Python and [RustXNG](https://github.com/sahenjp/RustXNG) in Rust | Runs on a private Docker network. Approved queries can leave these services for their configured public search providers. |

This setup blocks direct public egress from the DSH agent and blocks DeepSeek model, search, account, telemetry, and session-log providers in its profile. It still allows approved search queries and page requests to leave through the collector and search services. A selected model server or proxy can also forward requests to its own upstream.

## Plugin architecture

The image build fetches a pinned [homelab-dsh-plugins](https://github.com/recrack/homelab-dsh-plugins) revision and builds its Node.js packages. DSH does not clone the plugin repository or download plugin packages at startup. The launcher installs only IDs passed with `--plugin` into the persistent Web profile using local package links.

`dsh-context`, `dsh-claude-artifacts`, `dsh-claude-design`, and `dsh-crew` are Cordis bundles that add profile patches. `dsh-browser` is inserted as a Cordis plugin entry in shipped presets when selected. Plugin selection does not change the container firewall. Browser navigation still needs an explicit local-origin allowlist.

The design plugin depends on `dsh-claude-artifacts` for its local Artifacts page. Its upstream project is [Open Artifacts](https://github.com/JimLiu/open-artifacts), formerly Baoyu Design. The image continues to use the revision pinned in `homelab-dsh-plugins` until that pin is deliberately updated and the image is rebuilt.

## Run the secure deployment

Use the [English deployment guide](deploy/offline/README.md) or [한국어 배포 안내](deploy/offline/README.ko.md) to build and launch the Docker deployment. Do not use the upstream `npx @deepseek-ai/dsh web` command when you need these network and telemetry controls; that command does not use this repository's Docker policy.

For upstream DSH architecture and plugin development, see [architecture](docs/architecture.md), [your first plugin](docs/user/develop/basic/index.md), and [package and install a plugin](docs/user/develop/basic/publish.md).

## License

This repository is licensed under [MIT](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
