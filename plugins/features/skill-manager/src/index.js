import css from "./styles.css";

function installStyles() {
    const id = "ly-space-skill-manager-plugin-styles";
    if (document.getElementById(id)) return () => undefined;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
}

const plugin = {
    id: "skill-manager",
    activate(runtime) {
        const removeStyles = installStyles();
        const unregister = runtime.registerPanel({
            id: "skill-manager",
            group: "agent",
            title: "Skills",
            order: 20,
            mount(container) {
                const clientId = runtime.agent.clientId();
                let activeThreadId = "";
                container.innerHTML = `<div class="ly-skills"><div class="ly-skills__bar"><button data-refresh>刷新</button><button data-create>新建 Skill</button><button data-draft="conversation">从对话生成草稿</button><button data-draft="canvas">从画布生成草稿</button></div><div data-status class="ly-skills__status">正在读取 Skills…</div><div data-list></div></div>`;
                const status = container.querySelector("[data-status]");
                const list = container.querySelector("[data-list]");
                const setStatus = (text, error = false) => { status.textContent = text; status.dataset.error = error ? "true" : "false"; };
                const request = (payload) => runtime.agent.request(payload);
                const render = (skills) => {
                    list.replaceChildren(...skills.map((skill) => {
                        const row = document.createElement("article");
                        row.className = "ly-skills__item";
                        const title = document.createElement("strong");
                        title.textContent = skill.displayName || skill.name;
                        const meta = document.createElement("div");
                        meta.textContent = skill.path || "";
                        const enabled = document.createElement("input");
                        enabled.type = "checkbox";
                        enabled.checked = skill.enabled !== false;
                        enabled.addEventListener("change", () => void request({ method: "POST", path: `/agent/codex/skills/${encodeURIComponent(skill.name)}/enabled`, body: { enabled: enabled.checked, selector: { name: skill.name, path: skill.path } } }).then(load).catch((error) => setStatus(String(error), true)));
                        const edit = document.createElement("button");
                        edit.textContent = "编辑";
                        edit.disabled = !skill.managed;
                        edit.title = skill.managed ? "编辑此画布专属 Skill" : "仅可编辑当前插件创建的 Skill";
                        edit.addEventListener("click", () => void editSkill(skill));
                        const remove = document.createElement("button");
                        remove.textContent = "删除";
                        remove.disabled = !skill.managed;
                        remove.title = skill.managed ? "删除此画布专属 Skill" : "仅可删除当前插件创建的 Skill";
                        remove.addEventListener("click", () => { if (window.confirm(`删除 Skill「${skill.name}」？`)) void deleteSkill(skill); });
                        row.append(title, meta, enabled, edit, remove);
                        return row;
                    }));
                };
                const load = async () => {
                    try {
                        await runtime.agent.start();
                        if (runtime.canvas.available()) await runtime.canvas.sync(clientId);
                        const workspace = await request({ path: "/agent/codex/workspace" });
                        activeThreadId = String(workspace?.workspace?.activeThreadId || "");
                        const response = await request({ path: "/agent/codex/skills" });
                        const skills = Array.isArray(response?.data) ? response.data : [];
                        render(skills);
                        setStatus(skills.length ? `共 ${skills.length} 个 Skill` : "暂无 Skill");
                    } catch (error) { setStatus(error instanceof Error ? error.message : String(error), true); }
                };
                const create = async () => {
                    const name = window.prompt("Skill 名称（英文、小写、短横线）", "");
                    if (!name) return;
                    const description = window.prompt("Skill 描述", "用于画布任务的自定义 Skill");
                    if (description === null) return;
                    const instructions = window.prompt("Skill 指令（Markdown）", "# 使用说明\n\n描述何时和如何使用此 Skill。");
                    if (instructions === null) return;
                    try { await request({ method: "POST", path: "/agent/codex/skills", body: { name, description, instructions } }); await load(); } catch (error) { setStatus(String(error), true); }
                };
                const editSkill = async (skill) => {
                    try {
                        const response = await request({ path: `/agent/codex/skills/${encodeURIComponent(skill.name)}` });
                        const detail = response?.data || response;
                        const description = window.prompt("Skill 描述", detail.description || "");
                        if (description === null) return;
                        const instructions = window.prompt("Skill 指令（Markdown）", detail.instructions || "");
                        if (instructions === null) return;
                        await request({ method: "POST", path: `/agent/codex/skills/${encodeURIComponent(skill.name)}`, body: { description, instructions, expectedRevision: detail.revision || "" } });
                        await load();
                    } catch (error) { setStatus(error instanceof Error ? error.message : String(error), true); }
                };
                const deleteSkill = async (skill) => {
                    try {
                        const response = await request({ path: `/agent/codex/skills/${encodeURIComponent(skill.name)}` });
                        const detail = response?.data || response;
                        await request({ method: "POST", path: `/agent/codex/skills/${encodeURIComponent(skill.name)}/delete`, body: { expectedRevision: detail.revision || "" } });
                        await load();
                    } catch (error) { setStatus(error instanceof Error ? error.message : String(error), true); }
                };
                const draft = async (source) => {
                    try { setStatus("正在生成可编辑草稿…"); if (runtime.canvas.available()) await runtime.canvas.sync(clientId); const response = await request({ method: "POST", path: "/agent/codex/skills/draft", body: { source, clientId, threadId: activeThreadId } }); const text = JSON.stringify(response?.data || response, null, 2); window.prompt("Skill 草稿（复制后可编辑保存）", text); setStatus("草稿已生成"); } catch (error) { setStatus(String(error), true); }
                };
                container.querySelector("[data-refresh]").addEventListener("click", () => void load());
                container.querySelector("[data-create]").addEventListener("click", () => void create());
                container.querySelectorAll("[data-draft]").forEach((button) => button.addEventListener("click", () => void draft(button.dataset.draft)));
                void load();
                return () => container.replaceChildren();
            },
        });
        return () => { unregister(); removeStyles(); };
    },
};

export default plugin;
