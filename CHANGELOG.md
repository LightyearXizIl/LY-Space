# CHANGELOG

## Unreleased

## v0.0.4 - 2026-08-02

+ [修复] Agnes Image 2.x 改用原生 `return_base64`、顶层参考图和明确像素尺寸请求，移除不受支持的 `response_format`。
+ [新增] 生图结果槽位支持右键取消单张任务，记录区分成功、失败与取消。
+ [调整] 桌面版不再内置或启动 Codex/Canvas Agent；画布与节点插件继续使用通用 `applyOps`。
+ [优化] 窄窗口下生成结果操作按钮自动换行并完整显示文字；安装包校验上限收紧至 180 MiB。

## v0.0.3 - 2026-08-02

+ [新增] Windows 桌面端支持从 GitHub Release 检查、下载并在确认后自动安装新版本。
+ [调整] 版本更新仅展示 LY Space 正式版本，并按版本号倒序排列。
+ [修复] 内置 Canvas Agent 启动时不再弹出 Windows Terminal 黑窗。

## v0.0.2 - 2026-08-02

+ [优化] 桌面端改为独立渲染层与标准 Electron 打包，移除公开网页应用发布链路并显著缩小 Windows 安装包。
+ [修复] Windows 应用、安装程序、快捷方式、窗口和任务栏统一使用 LY Space 图标。

## v0.0.1 - 2026-08-02

+ [新增] 新增 Windows 桌面端与 NSIS 安装包，集成 LY Space 图标、中文菜单和本地 Canvas Agent。
+ [新增] 新增精修工作台，支持图片裁切、多档导出与一键发送到生图、视频创作台。
+ [新增] 支持 Agnes AI 官方 API、阿里云 OSS 参考图托管，以及结果与缓存目录配置。
+ [调整] 生图分辨率改为独立的 1K、2K、4K、8K 选项，桌面端不再限制参考图片文件大小。

继承项目的历史版本记录见 [UPSTREAM_CHANGELOG.md](UPSTREAM_CHANGELOG.md)。
