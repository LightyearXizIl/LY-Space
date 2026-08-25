const net = require("node:net");

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const address = server.address();
    await new Promise((resolve) => server.close(resolve));
    return typeof address === "object" && address ? address.port : 0;
}

async function waitForHealth(url, token) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch(`${url}/health?token=${encodeURIComponent(token)}`);
            if (response.ok) return;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw lastError || new Error("Agent 服务未就绪");
}

(async () => {
    const port = await reservePort();
    if (!port || !process.env.LY_SPACE_AGENT_TOKEN || !process.env.LY_SPACE_AGENT_DATA_DIR || !process.env.LY_SPACE_CODEX_PATH) throw new Error("Agent 服务启动参数不完整");
    process.env.PORT = String(port);
    // 保留上游包的相对模块结构；单文件 ESM bundle 会在 Node 内置模块上触发 dynamic require 错误。
    process.env.LY_SPACE_CANVAS_AGENT_MCP_ENTRY = process.env.LY_SPACE_CANVAS_AGENT_MCP_ENTRY || require("node:path").join(__dirname, "..", "node_modules", "@basketikun", "canvas-agent", "dist", "index.js");
    await import("../node_modules/@basketikun/canvas-agent/dist/index.js");
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url, process.env.LY_SPACE_AGENT_TOKEN);
    process.stdout.write(`LY_SPACE_AGENT_READY:${JSON.stringify({ url })}\n`);
})().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
