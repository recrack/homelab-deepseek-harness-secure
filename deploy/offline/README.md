# Local model with controlled web access

This deployment runs DeepSeek Harness in a Docker container on macOS or Linux. The agent sends model requests only to the private OpenAI-compatible server selected by `--base-url`; the DSH process has no direct public network route. A separate collector handles explicitly approved web requests.

## Build and run

Build the DSH image from the repository root. The image build fetches the pinned `homelab-dsh-plugins` commit and builds its packages; the first automatic search start can also clone and build pinned search engine sources. The launcher never pulls the DSH image or clones plugins at runtime.

```sh
docker build --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) -f deploy/offline/Dockerfile -t dsh-offline:local .
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1
```

Docker and Python 3 are required on the host. Run as a non-root user. The workspace cannot be the host home, a parent of the host home, or a container runtime directory. State must be a separate private directory. Existing Unix sockets in either mount are rejected. The launcher creates state with mode 0700 and publishes the optional UI and approval page on host loopback only.

The model server must be a private IPv4 HTTP listener using the `/v1` path. The relay accepts only model routes, removes credentials and cookies, does not log request bodies, and rejects redirects. A localhost cloud proxy still sends model data to its own upstream; use a server that keeps requests local.

The UI is available at `http://127.0.0.1:3081`. The launcher prints an approval URL in the controlling terminal. Headless runs can use `--approval-file /absolute/private-file` outside the workspace and state; the file is created with mode 0600 and removed on exit.

`--profile headless` disables the UI. `--port`, `--collector-port`, `--context-window`, and `--max-tokens` configure local listeners and model limits. `--model-patch` accepts a trusted Cordis overlay inside the workspace; it can change plugin and browser policy settings, while the container firewall remains fixed.

Optional plugins come from [homelab-dsh-plugins](https://github.com/recrack/homelab-dsh-plugins). Choose plugin IDs explicitly; the first selection installs them into the persistent Web profile, and those selections remain active on later launches. For example:

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --plugin dsh-context --plugin dsh-claude-artifacts --plugin dsh-claude-design --plugin dsh-crew
```

Available IDs are `dsh-browser`, `dsh-context`, `dsh-claude-artifacts`, `dsh-claude-design`, and `dsh-crew`. No optional plugin is activated for a new state directory unless selected. Existing profile selections stay installed. DSH Crew requires the Web profile and running local DSH hub; its worker providers use the selected local model, while vision and image generation remain disabled.

The `dsh-browser` plugin starts with an empty navigation allowlist. To allow one exact loopback or private IPv4 origin, select the plugin and repeat `--browser-origin` for each origin:

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --plugin dsh-browser --browser-origin http://127.0.0.1:4173
```

Loopback addresses refer to the DSH container. A browser page can still request its subresources, but the firewall permits only the configured addresses and ports. Use the approved Web collector for public websites.

## Installed DSH plugins

The secure image fetches plugin packages from the pinned commit in `homelab-dsh-plugins` at build time. It does not contact that repository when DSH starts. `--plugin <id>` installs and activates only the requested package; repeating the flag selects multiple packages. The launcher records these packages in the persistent Web profile and keeps them installed on later launches.

The `dsh-context` snapshot keeps its context panels and blocks its automatic catalog, balance, and recommendation requests. The Baoyu plugins provide the local Artifacts page and design canvas. DSH Crew requires the running DSH hub and uses the selected local model for both worker tiers; it cannot fall back to a standalone DeepSeek runtime. The multimodal vision and image-generation providers are disabled.

When `--hermes-acp-volume` is supplied, DSH Crew routes both worker tiers through the Hermes + Qwen agent preset. Without that volume, workers use the local DSH model. The launcher keeps the existing profile patch and other bundle selections when it adds these bundles.

For standard DSH plugin development, see [your first plugin](../../docs/user/develop/basic/index.md) and [package and install a plugin](../../docs/user/develop/basic/publish.md). A search or fetch backend can extend `dsh-web` by registering a provider; see [add another provider](../../packages/web/web/README.md#adding-a-provider). This offline deployment disables Plugin Manager; `deploy/offline/profile_plugins.py` installs only explicitly selected catalog entries.

## Local search

Search starts automatically by default. The launcher reuses running containers only when they use the reviewed SearXNG and RustXNG image digests, then connects them to a temporary internal network. If an engine is missing, the launcher clones its pinned source commit under `~/.cache/dsh-offline/search-services`, builds it, and starts it for the run. Managed containers stop and the temporary networks are removed when the launcher exits. `--search off` disables this behavior.

Managed SearXNG keeps only Google, Bing, DuckDuckGo, and Brave. Managed RustXNG disables its DeepSeek search engine and research API, and uses direct fetch. Both engines can send the approved query to their configured public search providers; those providers see the query and the engine's public IP. Neither the DSH agent container nor the collector sends queries to DeepSeek APIs.

The collector joins the temporary internal search network; the DSH agent container does not. The collector also keeps its separate approved public-fetch route. If you already manage the services yourself, set both endpoint URLs and the network name to use those instead of automatic discovery:

```sh
export DSH_SEARXNG_URL=http://172.30.0.3:8080
export DSH_RUSTXNG_URL=http://172.30.0.4:8080
export DSH_SEARCH_NETWORK=search-local-only
```

Manually configured engines must listen on private IPv4 addresses and expose the SearXNG-compatible `/search` JSON endpoint. A query beginning with `searxng:` or `rustxng:` selects one engine; other queries are sent to both and results are merged. The exact submitted query is shown for approval first. The collector sends only that query and result limit to the local engines, without cookies, credentials, conversation history, files, or logs.

The collector can also fetch a public HTTP(S) URL after explicit approval. DeepSeek root and subdomains, including `api.deepseek.com`, are rejected before approval or DNS. The collector has no public-search fallback. The temporary search Docker network contains only the selected search services and is removed at exit.

## Research with DSH

Open the Web UI and ask for current, source-backed information. DSH sends each `web_search` query through the collector, which displays the exact query for approval before forwarding it to the local search engines. Each public `web_fetch` request also waits for approval. Ask DSH to prefer primary sources, compare independent sources, state publication dates and uncertainty, and cite source URLs. For example:

> Research [question]. Find primary sources, fetch relevant pages after approval, compare claims across independent sources, and cite every factual claim. Separate confirmed facts from inference and include publication dates.

The configured public search providers can see approved queries and the search engine's public IP. Keep secrets and private project data out of search queries. The collector does not send conversation history, files, or credentials to search engines or fetched websites.

## Hermes ACP

Hermes is an optional ACP subagent backend, not the DSH model provider. DSH continues to use the selected local model for coordination; the `Hermes + Qwen` preset delegates coding work to the existing Hermes sidecar over a named Unix-socket volume.

Start the validated Hermes sidecar first, then pass its existing Docker volume to the launcher:

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --plugin dsh-crew --hermes-acp-volume dsh-hermes-acp-socket
```

The volume is mounted read-only at `/run/hermes-acp`. The socket must already exist and be connectable by the host user's numeric UID; the validated sidecar creates it for UID 1000. Select `dsh-crew` on each launch that uses the volume. DSH Crew selects the `Hermes + Qwen` preset for both worker tiers; its coordinator can read project files and delegate, but cannot directly write files, run commands, or install tools. The sidecar must use a local model endpoint and keep its own telemetry and public egress policy disabled; the launcher cannot enforce network policy inside a separately managed sidecar.

## Network and data handling

The DSH container starts with IPv4 and IPv6 input and output policies set to DROP. It permits loopback, model relay traffic, the collector API, the Web listener only when the host-loopback UI is enabled, and exact private origins supplied through `--browser-origin`. Docker DNS is blocked. The process drops all capabilities and enables `no-new-privileges` before loading DSH.

The base Cordis overlay disables DeepSeek model and account providers, DeepSeek web providers, remote session logging, OpenTelemetry session telemetry, plugin management, product analytics, and account UI. The model relay does not emit access logs. Telemetry opt-out environment variables are also set. These controls apply to this Docker deployment; a manually configured model server, search service, Hermes sidecar, or trusted `--model-patch` remains separately configured.

The collector accepts only `{query,maxResults}` for search and `{url}` for fetch. It queues the exact request until a person approves it in the host-only page; there is no automatic approval mode. Public sites receive only the approved query or URL and the collector's public IP. The approval URL contains a bearer token in its fragment; keep it private. Failed approval, local search errors, blocked destinations, or retrieval failures return an error without switching to another provider.

The launcher keeps the workspace at its host absolute path for imported session compatibility. Existing Session and attachment directories can be copied into `STATE/home/.dsh` while preserving relative paths and generations. Do not copy host credentials or the host's plugin configuration.

## Focused checks

```sh
python3 -m unittest discover -s deploy/offline -p 'test_*.py'
node --import tsx/esm --test deploy/offline/collector.test.mjs deploy/offline/local-search.test.mjs deploy/offline/web-provider.test.mjs deploy/offline/browser-policy.test.mjs deploy/offline/prepare-presets.test.mjs deploy/offline/preset-guard.test.mjs
```
