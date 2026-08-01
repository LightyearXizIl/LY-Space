---
name: open-canvas
description: 打开本地 Infinite Canvas 画布，并连接本地 Canvas Agent。用户要求打开、启动、进入或使用 Infinite Canvas 画布时使用。
---

# Open Infinite Canvas

LY Space 仅提供桌面端。已安装桌面应用时，直接打开 LY Space；应用会自动启动并连接内置 Canvas Agent。

## 本地开发

1. 启动渲染层，并使用 Vite 输出的 `Local` 地址：

```bash
cd desktop/renderer
bun install
bun run dev
```

2. 启动本地 Canvas Agent：

```bash
npx -y @basketikun/canvas-agent
```

3. 从启动输出取得 `Local URL` 和 `Connect token`，在 Codex 右侧浏览器打开：

```text
<Vite Local 地址>/canvas?mode=new&agentUrl=<Local URL>&agentToken=<Connect token>
```

## MCP 与连接地址

插件在新的 Codex 任务中加载时会自动启动 `npx -y @basketikun/canvas-agent mcp`。这个 MCP 进程提供画布工具；普通 Canvas Agent 提供 `Local URL` 和 `Connect token`。两个进程读取同一份本地配置，因此无需手动填写地址或 token。

## 打开模式

用户未明确指定时使用 `mode=new`。只有用户明确要求时才替换为：

- 最近画布：`mode=recent`
- 自己选择：`mode=choose`
