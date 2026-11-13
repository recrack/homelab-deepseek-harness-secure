# 离线 DSH 插件

[English](README.md) | 中文

Web 部署直接使用镜像内的这些插件软件包；运行时不会读取 `/home/pigma/dsh-private-validation`。

- `dsh-context` 0.83.0 是从 `bowenliang123/dsh-context` 暂存的版本；本地补丁会阻止目录、余额和推荐请求，并替换远程备用图标。
- `dsh-claude-artifacts` 与 `dsh-claude-design` 是私有验证 profile 中选定的软件包快照；每个软件包都保留其 `LICENSE` 和 `NOTICE.md`。
- `@zseven-w/dsh-crew` 在离线 Dockerfile 中从固定提交获取，并安装生产依赖。

profile 安装器会将 `dsh-context`、`dsh-claude-artifacts`、`dsh-claude-design` 和 `@zseven-w/dsh-crew` 加入持久化 Web profile。只有挂载 ACP（Agent Client Protocol）volume 时，DSH Crew 的工作智能体才会选择 Hermes ACP 预设；否则两个工作智能体层级都使用已配置的本地模型。视觉和图像生成提供方均已关闭，任务派发需要正在运行的 DSH hub。
