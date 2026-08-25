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
    await import("./agent-service.mjs");
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url, process.env.LY_SPACE_AGENT_TOKEN);
    process.stdout.write(`LY_SPACE_AGENT_READY:${JSON.stringify({ url })}\n`);
})().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
