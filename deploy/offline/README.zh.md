# 本地模型与受控 Web 访问

[English](README.md) | 中文

此部署会在 macOS 或 Linux 的 Docker 容器中运行 DeepSeek Harness。agent（智能体）只向 `--base-url` 指定的专用 OpenAI 兼容服务器发送模型请求；DSH 进程没有直连公网的路由。单独的采集器负责处理经明确批准的 Web 请求。

## 构建和运行

在仓库根目录构建 DSH 镜像。首次自动启动搜索时，程序可能会克隆并构建固定版本的搜索引擎源码；启动器不会拉取 DSH 镜像。

```sh
docker build --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) -f deploy/offline/Dockerfile -t dsh-offline:local .
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1
```

主机上必须安装 Docker 和 Python 3。请以非 `root` 用户运行。workspace 不能是主机用户目录、它的父目录或容器运行时目录。状态目录必须单独且私有。任一挂载目录中存在 Unix socket 时都会拒绝启动。启动器将状态目录权限设为 0700，并且只在主机环回地址上发布可选 UI 和审批页面。

模型服务器必须是使用 `/v1` 路径的专用 IPv4 HTTP 监听器。中继只接受模型路由，会移除凭据和 cookie，不记录请求正文，并拒绝重定向。本机云代理仍会把模型数据发送到自己的上游；请使用能将请求保留在本地的服务器。

UI 位于 `http://127.0.0.1:3081`。启动器会在当前终端打印审批 URL。无 UI 运行可使用 `--approval-file /absolute/private-file`，该文件必须位于 workspace 和 state 之外；文件权限为 0600，并会在退出时删除。

`--profile headless` 会关闭 UI。`--port`、`--collector-port`、`--context-window` 和 `--max-tokens` 用于配置本地监听端口和模型限制。`--model-patch` 接受 workspace 内受信任的 Cordis overlay；它可以更改插件和浏览器策略设置，但不会改变容器防火墙。

固定版本的 `dsh-browser` 插件可用于 Web 预设。它的导航允许列表和容器防火墙默认不允许访问任何浏览器目标。要访问本地页面，请添加一个精确的环回或私有 IPv4 源地址；可以重复该选项添加其他地址：

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --browser-origin http://127.0.0.1:4173
```

环回地址指 DSH 容器内的地址。浏览器页面仍可请求其子资源，但防火墙仅允许访问已配置的地址和端口。访问公共网站请使用获批的 Web 采集器。

## 已安装的 DSH 插件

首次启动 Web 时会将 `dsh-context`、`dsh-claude-artifacts`、`dsh-claude-design` 和 `@zseven-w/dsh-crew` 加入持久化 Web profile。复制的软件包及其许可证位于 `deploy/offline/plugins`；镜像构建完成后，部署不依赖 `/home/pigma/dsh-private-validation`。

`dsh-context` 快照保留上下文面板，并阻止自动目录、余额和推荐请求。Baoyu 插件提供本地 Artifacts 页面和设计画布。DSH Crew 需要正在运行的 DSH hub；两个工作智能体层级都使用已选的本地模型，不能回退到独立运行的 DeepSeek 服务。多模态视觉和图像生成提供方已关闭。

提供 `--hermes-acp-volume` 时，DSH Crew 会通过 Hermes + Qwen agent 预设为两个工作智能体层级派发任务。未提供该 volume 时，它们使用本地 DSH 模型。启动器添加这些组合包时会保留已有 profile patch 和其他组合包选择。

## 本地搜索

默认情况下会自动启动搜索。启动器仅在运行中的容器使用已审核的 SearXNG 和 RustXNG 镜像摘要时复用这些容器，然后将它们接入临时内部网络。缺少搜索引擎时，启动器会在 `~/.cache/dsh-offline/search-services` 下克隆固定提交的源码、构建并启动服务。启动器退出时会停止其管理的容器并移除临时网络。`--search off` 会关闭此功能。

受管 SearXNG 只启用 Google、Bing、DuckDuckGo 和 Brave。受管 RustXNG 会关闭 DeepSeek 搜索引擎和研究 API，并使用直接抓取。两个引擎都可能把获批的查询发送给各自配置的公共搜索提供方；这些提供方会看到查询内容和搜索引擎的公网 IP。DSH agent 容器和采集器都不会向 DeepSeek API 发送查询。

采集器会加入临时内部搜索网络；DSH agent 容器不会加入。采集器也保留单独获批的公共抓取通道。如果你已自行管理这些服务，可设置两个服务 URL 和网络名称，让启动器使用它们而不进行自动发现：

```sh
export DSH_SEARXNG_URL=http://172.30.0.3:8080
export DSH_RUSTXNG_URL=http://172.30.0.4:8080
export DSH_SEARCH_NETWORK=search-local-only
```

手动配置的引擎必须监听私有 IPv4 地址，并提供兼容 SearXNG 的 `/search` JSON API。以 `searxng:` 或 `rustxng:` 开头的查询会选择一个引擎；其他查询会同时发送到两个引擎并合并结果。提交的完整查询会先显示给用户审批。采集器只会向本地引擎发送该查询和结果数量上限，不会发送 cookie、凭据、对话历史、文件或日志。

采集器也可以在明确审批后抓取公共 HTTP(S) URL。DeepSeek 根域及其子域（包括 `api.deepseek.com`）会在审批前或 DNS 查询前被拒绝。采集器没有公共搜索备用路径。临时搜索 Docker 网络只包含选定的搜索服务，并会在退出时移除。

## Hermes ACP（Agent Client Protocol）

Hermes 是可选的 ACP subagent 后端，不是 DSH 模型提供商。DSH 继续使用选定的本地模型进行协调；`Hermes + Qwen` 预设通过命名 Unix socket volume，将编码任务派发给现有的 Hermes 服务。

请先启动已验证的 Hermes 服务，再将其已有的 Docker volume 传给启动器：

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --hermes-acp-volume dsh-hermes-acp-socket
```

该 volume 以只读方式挂载到 `/run/hermes-acp`。socket 必须已存在，并且必须允许主机用户的数字 UID 连接；已验证的 Hermes 服务会为 UID 1000 创建该 socket。挂载 volume 时，DSH Crew 会为两个工作智能体层级选择 `Hermes + Qwen` 预设。其协调器可以读取项目文件并派发任务，但不能直接写文件、运行命令或安装工具。Hermes 服务必须使用本地模型 API 地址，并关闭自身遥测（telemetry）和公网出口策略；启动器无法强制管理单独运行的 Hermes 服务的网络策略。

## 网络和数据处理

DSH 容器启动时会将 IPv4 和 IPv6 的入站及出站策略设为 DROP。它只允许环回流量、模型中继流量、采集器 API、仅在启用主机环回 UI 时开放的 Web 监听器，以及通过 `--browser-origin` 提供的精确私有源。Docker DNS 会被阻止。加载 DSH 前，进程会丢弃全部 capability 并启用 `no-new-privileges`。

基础 Cordis overlay 会关闭 DeepSeek 模型和账户提供方、DeepSeek Web 提供方、远程会话日志、OpenTelemetry 会话遥测、插件管理、产品分析和账户 UI。模型中继不会输出访问日志。系统也会设置遥测退出环境变量。这些控制适用于此 Docker 部署；手动配置的模型服务器、搜索服务、Hermes 服务或受信任的 `--model-patch` 仍需单独配置。

采集器搜索请求只接受 `{query,maxResults}`，抓取请求只接受 `{url}`。它会将完整请求排入队列，直到有人在仅主机可访问的页面上批准；没有自动审批模式。公共网站只会收到获批的查询或 URL，以及采集器的公网 IP。审批 URL 的 `#` 片段中包含可持有即授权的令牌；请妥善保管。审批失败、本地搜索错误、目标被阻止或抓取失败时，都会返回错误，不会切换到其他提供方。

为兼容导入的会话，启动器会在主机绝对路径上保留 workspace。可以将现有会话和附件目录复制到 `STATE/home/.dsh`，并保留相对路径及各代数据。不要复制主机凭据或主机的插件配置。

## 定向检查

```sh
python3 -m unittest discover -s deploy/offline -p 'test_*.py'
node --import tsx/esm --test deploy/offline/collector.test.mjs deploy/offline/local-search.test.mjs deploy/offline/web-provider.test.mjs deploy/offline/browser-policy.test.mjs deploy/offline/prepare-presets.test.mjs deploy/offline/preset-guard.test.mjs
```
