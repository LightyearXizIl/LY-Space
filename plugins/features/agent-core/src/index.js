import css from "./styles.css";

function installStyles() {
    const id = "ly-space-agent-core-plugin-styles";
    if (document.getElementById(id)) return () => undefined;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
}

const plugin = {
    id: "agent-core",
    activate(runtime) {
        const removeStyles = installStyles();
        const unregister = runtime.registerPanel({
            id: "agent-core",
            group: "agent",
            title: "对话",
            order: 10,
            mount(container) {
                let disposed = false;
                let clientId = runtime.agent.clientId();
                let activeThreadId = "";
                let conversation = null;
                let unsubscribeEvents = null;
                let selectedModel = "";
                let selectedEffort = "";
                let attachments = [];
                const messages = [];
                container.innerHTML = `
                    <div class="ly-agent">
                        <div class="ly-agent__status" data-status>准备连接本地 Agent…</div>
                        <div class="ly-agent__toolbar">
                            <button type="button" data-action="new">新对话</button>
                            <button type="button" data-action="history">历史</button>
                            <button type="button" data-action="settings">模型与凭据</button>
                            <select data-model aria-label="模型"><option value="">默认模型</option></select>
                            <select data-effort aria-label="推理强度"><option value="">默认强度</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">最高</option></select>
                        </div>
                        <div class="ly-agent__messages" data-messages aria-live="polite"></div>
                        <form class="ly-agent__composer" data-form>
                            <textarea rows="3" data-prompt placeholder="描述你希望在画布上完成的任务。涉及修改、删除、文件、网络或 MCP 时会请求确认。"></textarea>
                            <input type="file" data-attachments accept="image/*" multiple aria-label="添加图片附件" />
                            <div class="ly-agent__attachments" data-attachments-label></div>
                            <button type="submit" data-send>发送</button>
                        </form>
                    </div>`;
                const status = container.querySelector("[data-status]");
                const list = container.querySelector("[data-messages]");
                const form = container.querySelector("[data-form]");
                const prompt = container.querySelector("[data-prompt]");
                const modelSelect = container.querySelector("[data-model]");
                const effortSelect = container.querySelector("[data-effort]");
                const attachmentInput = container.querySelector("[data-attachments]");
                const attachmentLabel = container.querySelector("[data-attachments-label]");

                const setStatus = (text, error = false) => {
                    if (status) {
                        status.textContent = text;
                        status.dataset.error = error ? "true" : "false";
                    }
                };
                const render = () => {
                    if (!list) return;
                    list.replaceChildren(...messages.map((item) => {
                        const row = document.createElement("article");
                        row.className = `ly-agent__message ly-agent__message--${item.role}`;
                        const title = document.createElement("strong");
                        title.textContent = item.role === "user" ? "你" : item.role === "error" ? "错误" : "Agent";
                        const text = document.createElement("div");
                        text.textContent = item.text;
                        row.append(title, text);
                        return row;
                    }));
                    list.scrollTop = list.scrollHeight;
                };
                const request = (payload) => runtime.agent.request(payload);
                const renderAttachments = () => {
                    if (attachmentLabel) attachmentLabel.textContent = attachments.length ? `已附加 ${attachments.length} 张图片` : "";
                };
                const handleEvent = async (event, data) => {
                    if (event === "hello") {
                        conversation = data?.conversation || conversation;
                        activeThreadId = String(data?.workspace?.activeThreadId || activeThreadId);
                        return;
                    }
                    if (event === "conversation_changed") {
                        conversation = data || conversation;
                        setStatus(conversation?.status === "running" ? "Agent 正在处理…" : conversation?.status === "ready" || conversation?.status === "warning" ? "Agent 已就绪" : conversation?.error || "Agent 正在初始化…", conversation?.status === "failed");
                        return;
                    }
                    if (event === "chat_message" && data?.message?.text) {
                        messages.push({ role: data.message.role === "user" ? "user" : "assistant", text: String(data.message.text) });
                        render();
                        return;
                    }
                    if (event === "codex_approval" && data?.requestId) {
                        const approved = window.confirm(`Agent 请求授权：${data.reason || data.method || "受限操作"}\n\n确认仅允许本次操作；取消将拒绝。`);
                        await request({ method: "POST", path: "/agent/codex/approval", body: { requestId: data.requestId, decision: approved ? "accept" : "decline" } });
                        return;
                    }
                    if (event !== "tool_call" || !data?.requestId) return;
                    try {
                        if (data.name === "canvas_apply_ops") {
                            const ops = Array.isArray(data.input?.ops) ? data.input.ops : [];
                            const approved = window.confirm(`Agent 希望修改当前画布（${ops.length} 项操作）。\n\n确认后会执行本次画布操作。`);
                            if (!approved) throw new Error("用户拒绝画布修改");
                            runtime.canvas.applyOps(ops);
                            await runtime.agent.resolveTool(clientId, { requestId: data.requestId, result: { ok: true, applied: ops.length } });
                            return;
                        }
                        const result = await runtime.host.executeTool(String(data.name || ""), data.input && typeof data.input === "object" ? data.input : {});
                        await runtime.agent.resolveTool(clientId, { requestId: data.requestId, result });
                    } catch (error) {
                        await runtime.agent.resolveTool(clientId, { requestId: data.requestId, error: error instanceof Error ? error.message : String(error) });
                    }
                };
                const activateCanvasClient = async () => {
                    if (runtime.canvas.available()) await runtime.canvas.sync(clientId);
                };
                const loadWorkspace = async () => {
                    const response = await request({ path: "/agent/codex/workspace" });
                    activeThreadId = String(response?.workspace?.activeThreadId || "");
                    conversation = response?.conversation || null;
                    return response;
                };
                const loadHistory = async () => {
                    const response = await request({ path: "/agent/codex/threads" });
                    const items = Array.isArray(response?.data) ? response.data : [];
                    messages.splice(0, messages.length, ...items.slice(0, 20).map((item) => ({ role: "assistant", text: item.name || item.preview || item.id })));
                    render();
                    setStatus(items.length ? `已加载 ${items.length} 个历史对话` : "暂无历史对话");
                };
                const loadModels = async () => {
                    const response = await request({ path: "/agent/codex/models" });
                    const models = Array.isArray(response?.data) ? response.data : [];
                    if (!modelSelect) return;
                    modelSelect.replaceChildren(new Option("默认模型", ""), ...models.map((item) => new Option(String(item.displayName || item.name || item.id || "未命名模型"), String(item.id || item.name || ""))));
                    modelSelect.value = selectedModel;
                };
                const connect = async () => {
                    try {
                        setStatus("正在启动 Agent…");
                        await runtime.agent.start();
                        unsubscribeEvents?.();
                        unsubscribeEvents = await runtime.agent.subscribe(clientId, (event, data) => void handleEvent(event, data));
                        await activateCanvasClient();
                        await loadWorkspace();
                        await loadModels().catch(() => undefined);
                        setStatus(conversation?.status === "ready" || conversation?.status === "warning" ? "Agent 已就绪" : "Agent 正在初始化 Codex 与 MCP…");
                    } catch (error) {
                        setStatus(error instanceof Error ? error.message : String(error), true);
                    }
                };
                const send = async () => {
                    const value = String(prompt?.value || "").trim();
                    if (!value) return;
                    messages.push({ role: "user", text: value });
                    prompt.value = "";
                    render();
                    try {
                        setStatus("Agent 正在处理…");
                        const response = await request({ method: "POST", path: "/agent/codex/turn", body: { clientId, threadId: activeThreadId, conversationId: conversation?.conversationId || "", expectedRevision: conversation?.revision || 0, prompt: value, attachments, model: selectedModel || undefined, effort: selectedEffort || undefined, permissionMode: "request" } });
                        activeThreadId = String(response?.threadId || activeThreadId);
                        attachments = [];
                        if (attachmentInput) attachmentInput.value = "";
                        renderAttachments();
                        messages.push({ role: "assistant", text: "任务已提交。完成后可打开历史查看完整消息与工具记录。" });
                        setStatus("任务执行中；涉及受限操作会请求确认");
                    } catch (error) {
                        const text = error instanceof Error ? error.message : String(error);
                        messages.push({ role: "error", text });
                        setStatus(text, true);
                    }
                    render();
                };
                const openSettings = () => {
                    const url = window.prompt("远程 Agent 地址（留空使用本地 Agent；远程地址必须 HTTPS）", "");
                    if (url === null) return;
                    if (!url.trim()) return void runtime.agent.clearRemoteCredentials().then(connect).catch((error) => setStatus(String(error), true));
                    const token = window.prompt("远程 Agent 令牌（将由桌面端加密保存）", "");
                    if (!token) return;
                    void runtime.agent.setRemoteCredentials({ url: url.trim(), token }).then(connect).catch((error) => setStatus(String(error), true));
                };
                form?.addEventListener("submit", (event) => { event.preventDefault(); void send(); });
                modelSelect?.addEventListener("change", () => { selectedModel = modelSelect.value; });
                effortSelect?.addEventListener("change", () => { selectedEffort = effortSelect.value; });
                attachmentInput?.addEventListener("change", async () => {
                    try {
                        const files = [...(attachmentInput.files || [])];
                        if (files.some((file) => !file.type.startsWith("image/"))) throw new Error("仅支持图片附件");
                        if (files.some((file) => file.size > 8 * 1024 * 1024)) throw new Error("单张图片不能超过 8 MiB");
                        attachments = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: String(reader.result || "") });
                            reader.onerror = () => reject(new Error("图片读取失败"));
                            reader.readAsDataURL(file);
                        })));
                        renderAttachments();
                    } catch (error) {
                        attachments = [];
                        attachmentInput.value = "";
                        renderAttachments();
                        setStatus(error instanceof Error ? error.message : String(error), true);
                    }
                });
                container.querySelector("[data-action='new']")?.addEventListener("click", () => void request({ method: "POST", path: "/agent/codex/threads/new", body: { clientId, permissionMode: "request" } }).then((response) => { activeThreadId = String(response?.thread?.id || ""); conversation = response?.conversation || null; messages.splice(0); render(); setStatus("已创建新对话，正在初始化…"); }).catch((error) => setStatus(String(error), true)));
                container.querySelector("[data-action='history']")?.addEventListener("click", () => void loadHistory().catch((error) => setStatus(String(error), true)));
                container.querySelector("[data-action='settings']")?.addEventListener("click", openSettings);
                void connect();
                return () => { disposed = true; unsubscribeEvents?.(); container.replaceChildren(); };
            },
        });
        return () => { unregister(); removeStyles(); };
    },
};

export default plugin;
