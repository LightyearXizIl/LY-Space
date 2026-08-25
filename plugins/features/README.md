# 官方功能插件

这里的插件不同于 `plugins/canvas`：它们由主进程安装、校验和管理，可注册应用级面板或启动受控本地服务。

- `agent-core`：Canvas Agent 前端面板与本地服务启动器，不包含 Codex 运行时。
- `skill-manager`：依赖 Agent Core 的 Skills 管理页签。
- `registry`：构建浏览器入口、服务目录、校验信息和 `official-feature-plugins.json`。

产物只发布到 `plugins-dist` 分支或 GitHub Release，不能加入桌面 `build.files`。本地构建：`cd plugins/features/registry && npm install && npm run build`。
