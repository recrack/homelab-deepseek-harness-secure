---
kind: upgrade-guide
description: "离线插件现在需要显式选择，不再自动安装到每个新 Web 配置中。"
---
# 离线插件需要显式选择

[English](guide.md) | 中文

## 变更

离线启动器以前会把 `dsh-context`、两个 Baoyu 插件和 DSH Crew 添加到每个新 Web 配置，并在每个 Web preset 中挂载 `dsh-browser`。现在只有通过可重复使用的 `--plugin <id>` 选项选择的插件才会安装和启用。所选插件会记录在持久化 Web 配置中，因此后续启动仍保持启用。现有配置会保留已安装的 bundle 选择。使用 `--browser-origin` 的每次启动都必须选择浏览器；传入 `--hermes-acp-volume` 的每次启动都必须选择 `dsh-crew`。

镜像会在构建期间获取固定版本的 [homelab-dsh-plugins](https://github.com/recrack/homelab-dsh-plugins)。DSH 启动时不会 clone 插件源代码。

## 迁移

1. 在仓库根目录用 `docker build --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) -f deploy/offline/Dockerfile -t dsh-offline:local .` 重新构建镜像。
2. 在新的状态目录中，为每个需要的插件添加一个 `--plugin <id>` 选项。可用 ID 为 `dsh-browser`、`dsh-context`、`dsh-claude-artifacts`、`dsh-claude-design` 和 `dsh-crew`。重复该选项即可选择多个插件。
3. 使用浏览器导航时，在该次启动中添加 `--plugin dsh-browser` 和精确的私有 `--browser-origin` 选项。使用 Hermes ACP 时，将 `--plugin dsh-crew` 与 `--hermes-acp-volume` 一起传入。
4. 保持使用相同的 `--state` 目录以保留配置。运行 `python3 deploy/offline/run.py --help`，确认启动器提供 `--plugin`。
