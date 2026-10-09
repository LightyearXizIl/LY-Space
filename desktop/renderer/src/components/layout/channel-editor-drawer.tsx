import { App, Button, Drawer, Input, InputNumber, Segmented, Select, Space, Switch } from "antd";
import { ExternalLink, ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { AGNES_BASE_URL, ARK_AGENT_PLAN_BASE_URL, ARK_STANDARD_BASE_URL, createBalanceQuery, defaultBaseUrlForApiFormat, GRSAI_DOMESTIC_BASE_URL, GRSAI_GLOBAL_BASE_URL, isArkAgentPlanBaseUrl, normalizeChannelModels, type ApiCallFormat, type BalanceQueryMode, type ChannelBalanceQuery, type ChannelModel, type ChannelModelCapability, type ImageModelFeature, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";
import { fetchChannelBalance, formatBalance, resolveBalanceUrl } from "@/services/api/balance";

const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "GRS AI", value: "grsai" },
    { label: "Gemini", value: "gemini" },
    { label: "Agnes AI", value: "agnes" },
    { label: "火山方舟", value: "ark" },
];

const capabilityOptions: Array<{ label: string; value: ChannelModelCapability }> = [
    { label: "生图", value: "image" },
    { label: "视频", value: "video" },
    { label: "文本", value: "text" },
    { label: "音频", value: "audio" },
    { label: "待分类", value: "unknown" },
];
const balanceModeOptions: Array<{ label: string; value: BalanceQueryMode }> = [
    { label: "自动识别（推荐）", value: "auto" },
    { label: "GRS AI", value: "grsai" },
    { label: "钱包接口（星流等）", value: "wallet" },
    { label: "OpenAI 账单", value: "openai-billing" },
    { label: "自定义", value: "custom" },
];
const imageFeatureOptions: Array<{ label: string; value: ImageModelFeature }> = [
    { label: "全图编辑", value: "image-edit" }, { label: "蒙版修复", value: "mask-edit" },
    { label: "生成式高清", value: "generative-upscale" }, { label: "专用超分", value: "dedicated-super-resolution" },
];

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [checkingBalance, setCheckingBalance] = useState(false);
    const [balancePreview, setBalancePreview] = useState("");
    const { message } = App.useApp();

    useEffect(() => {
        if (open && channel) {
            setDraft(channel);
            setBalancePreview("");
        }
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const balance = draft.balanceQuery || createBalanceQuery();
    const patchBalance = (value: Partial<ChannelBalanceQuery>) => patch({ balanceQuery: { ...balance, ...value } });

    const testBalance = async () => {
        setCheckingBalance(true);
        try {
            setBalancePreview(formatBalance(await fetchChannelBalance({ ...draft, balanceQuery: balance }, balance)));
        } catch (error) {
            setBalancePreview("");
            message.error(error instanceof Error ? error.message : "余额查询失败");
        } finally {
            setCheckingBalance(false);
        }
    };

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (models: ChannelModel[]) => setModels(models);

    const setCapability = (name: string, capability: ChannelModelCapability) =>
        setModels(
            draft.models.map((model) =>
                model.name === name
                    ? {
                          ...model,
                          capability,
                          category: capability === "unknown" ? "unknown" : capability,
                          classificationSource: "manual",
                      }
                    : model,
            ),
        );
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const setImageFeatures = (name: string, imageFeatures: ImageModelFeature[]) => setModels(draft.models.map((model) => (model.name === name ? { ...model, imageFeatures: imageFeatures.length ? imageFeatures : undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || "未命名渠道", models: normalizeChannelModels(draft.models), balanceQuery: createBalanceQuery(draft.balanceQuery) });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title="编辑渠道"
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" onClick={save}>
                        保存
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">渠道名称</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">协议</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">接口地址</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                    {draft.apiFormat === "grsai" ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                            <span>节点：</span>
                            <Button size="small" type={draft.baseUrl === GRSAI_DOMESTIC_BASE_URL ? "primary" : "default"} onClick={() => patch({ baseUrl: GRSAI_DOMESTIC_BASE_URL })}>国内</Button>
                            <Button size="small" type={draft.baseUrl === GRSAI_GLOBAL_BASE_URL ? "primary" : "default"} onClick={() => patch({ baseUrl: GRSAI_GLOBAL_BASE_URL })}>全球</Button>
                            <span>支持手动填写其他 GRS 节点。</span>
                        </div>
                    ) : null}
                    {draft.apiFormat === "agnes" ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                            <Button size="small" type={draft.baseUrl === AGNES_BASE_URL ? "primary" : "default"} onClick={() => patch({ baseUrl: AGNES_BASE_URL })}>官方 API 网关</Button>
                            <a href="https://www.agnes-ai.com/" target="_blank" rel="noreferrer">国际站 <ExternalLink className="inline size-3" /></a>
                            <a href="https://agnes-ai.cn/" target="_blank" rel="noreferrer">中国站 <ExternalLink className="inline size-3" /></a>
                            <a href="https://agnes-ai.com/en/docs/quickstart" target="_blank" rel="noreferrer">开发文档 <ExternalLink className="inline size-3" /></a>
                        </div>
                    ) : null}
                    {draft.apiFormat === "ark" ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                            <Button size="small" type={!isArkAgentPlanBaseUrl(draft.baseUrl) && draft.baseUrl.replace(/\/+$/, "") === ARK_STANDARD_BASE_URL ? "primary" : "default"} onClick={() => patch({ baseUrl: ARK_STANDARD_BASE_URL })}>标准方舟</Button>
                            <Button size="small" type={isArkAgentPlanBaseUrl(draft.baseUrl) ? "primary" : "default"} onClick={() => patch({ baseUrl: ARK_AGENT_PLAN_BASE_URL })}>Agent Plan</Button>
                            <span>可粘贴完整接口地址；标准方舟可拉取模型，Agent Plan 请按套餐手动增加模型 ID。</span>
                        </div>
                    ) : null}
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>
            </div>

            <div className="mt-6 flex items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">余额查询</div>
                    <div className="mt-0.5 text-xs text-stone-500">用本渠道 API Key 查询中转站余额，启用后在画布顶栏实时显示。</div>
                </div>
                <Switch checked={balance.enabled} onChange={(enabled) => patchBalance({ enabled })} />
            </div>
            {balance.enabled ? (
                <div className="mt-2 grid gap-4 rounded-lg border border-stone-200 p-3 md:grid-cols-2 dark:border-stone-800">
                    <label className="block md:col-span-2">
                        <span className="mb-1 block text-sm font-medium">查询方式</span>
                        <Select className="w-full" value={balance.mode} onChange={(mode) => patchBalance({ mode })} options={balanceModeOptions} />
                        <div className="mt-1 text-xs text-stone-500">
                            {balance.mode === "auto" ? "自动依次尝试该协议已知的余额端点，命中即用。" : "按所选方式查询；查不到可改用「自定义」填写具体路径。"}
                        </div>
                    </label>
                    {balance.mode === "custom" ? (
                        <>
                            <label className="block md:col-span-2">
                                <span className="mb-1 block text-sm font-medium">查询路径</span>
                                <Input value={balance.path} onChange={(event) => patchBalance({ path: event.target.value })} placeholder="/wallet" />
                                <div className="mt-1 truncate text-xs text-stone-500" title={resolveBalanceUrl(draft.baseUrl, balance.path)}>
                                    完整地址：{resolveBalanceUrl(draft.baseUrl, balance.path) || "—"}
                                </div>
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-sm font-medium">请求方法</span>
                                <Segmented block value={balance.method === "POST" ? "POST" : "GET"} onChange={(value) => patchBalance({ method: value as "GET" | "POST" })} options={["GET", "POST"]} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-sm font-medium">鉴权位置</span>
                                <Segmented block value={balance.authMode === "body" ? "body" : "header"} onChange={(value) => patchBalance({ authMode: value as "header" | "body" })} options={[{ label: "请求头", value: "header" }, { label: "请求体", value: "body" }]} />
                            </label>
                            {balance.authMode === "body" ? (
                                <label className="block md:col-span-2">
                                    <span className="mb-1 block text-sm font-medium">请求体字段名</span>
                                    <Input value={balance.bodyKey || ""} onChange={(event) => patchBalance({ bodyKey: event.target.value })} placeholder="apiKey" />
                                </label>
                            ) : null}
                        </>
                    ) : null}
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">金额字段</span>
                        <Input value={balance.field || ""} onChange={(event) => patchBalance({ field: event.target.value })} placeholder="留空自动识别" />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">刷新间隔（秒）</span>
                        <InputNumber className="w-full" min={10} max={3600} value={balance.intervalSec} onChange={(value) => patchBalance({ intervalSec: typeof value === "number" ? value : undefined })} />
                    </label>
                    <div className="flex items-center gap-3 md:col-span-2">
                        <Button size="small" loading={checkingBalance} onClick={() => void testBalance()}>
                            测试查询
                        </Button>
                        {balancePreview ? <span className="text-xs text-stone-500">当前余额：{balancePreview}</span> : null}
                    </div>
                </div>
            ) : null}

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">渠道模型</div>
                    <div className="mt-0.5 text-xs text-stone-500">已选 {draft.models.length} 个；为每个模型指定能力并可自定义调用脚本。</div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                    选择模型
                </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ChannelModelCapability)} />
                                <Button
                                    size="small"
                                    disabled={model.capability === "unknown"}
                                    title={model.capability === "unknown" ? "请先指定模型能力" : undefined}
                                    type={model.script ? "primary" : "default"}
                                    ghost={Boolean(model.script)}
                                    onClick={() => model.capability !== "unknown" && setScriptTarget({ name: model.name, capability: model.capability as ModelCapability, value: model.script || "" })}
                                >
                                    {model.script ? "脚本已设" : "调用脚本"}
                                </Button>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                            {model.capability === "image" ? <Select mode="multiple" size="small" className="w-full" placeholder="图片能力（精修 AI 工具会据此筛选）" value={model.imageFeatures || []} options={imageFeatureOptions} onChange={(value) => setImageFeatures(model.name, value)} /> : null}
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">点击「选择模型」拉取或手动增加模型。</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}
