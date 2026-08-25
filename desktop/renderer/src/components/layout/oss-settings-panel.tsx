import { useEffect, useState } from "react";
import { App, Button, Form, Input, Select, Space } from "antd";

import { defaultOssHostingConfig, loadOssHostingConfig, saveOssHostingConfig, type OssHostingConfig } from "@/services/oss-hosting";
import { enqueueReferenceHandoff } from "@/services/reference-handoff";

function isHttpsUrl(value: unknown) {
    try {
        return typeof value === "string" && new URL(value.trim()).protocol === "https:";
    } catch {
        return false;
    }
}

function httpsUrlRule(emptyMessage: string) {
    return {
        validator: (_: unknown, value: unknown) => {
            if (!String(value || "").trim()) return Promise.reject(new Error(emptyMessage));
            return isHttpsUrl(value) ? Promise.resolve() : Promise.reject(new Error("请输入有效的 HTTPS 地址"));
        },
    };
}

export function OssSettingsPanel() {
    const { message } = App.useApp();
    const [form] = Form.useForm<OssHostingConfig>();
    const [saving, setSaving] = useState(false);
    const [publicImageUrl, setPublicImageUrl] = useState("");
    const provider = Form.useWatch("provider", form) || "aliyun-oss";

    useEffect(() => {
        let disposed = false;
        void loadOssHostingConfig()
            .then((config) => {
                if (!disposed) form.setFieldsValue(config);
            })
            .catch(() => {
                if (disposed) return;
                form.setFieldsValue(defaultOssHostingConfig);
                message.warning("OSS 配置读取失败，已显示默认设置；原配置未被修改");
            });
        return () => {
            disposed = true;
        };
    }, [form, message]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const values = await form.validateFields();
            form.setFieldsValue(await saveOssHostingConfig(values));
            message.success("OSS 设置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "OSS 设置保存失败");
        } finally {
            setSaving(false);
        }
    };

    const addPublicImageUrl = async () => {
        const url = publicImageUrl.trim();
        if (!isHttpsUrl(url)) {
            message.error("请输入公网 HTTPS 图片 URL");
            return;
        }
        const name = new URL(url).pathname.split("/").pop() || "public-image";
        await enqueueReferenceHandoff({ target: "video", storageKey: "", name, type: "image/png", width: 0, height: 0, url });
        setPublicImageUrl("");
        window.dispatchEvent(new Event("lyspace:reference-handoff-created"));
        message.success("公网图片已加入视频创作台参考图");
    };

    return (
        <div className="space-y-5">
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-3 text-sm font-semibold">参考素材托管</div>
                <div className="mb-3 text-xs leading-5 text-stone-500 dark:text-stone-400">配置后，本地参考图、参考视频和参考音频会转为公网 HTTPS 地址，适配 Agnes 等只接受公网素材的服务。密钥只保存在你自己的签名服务或 Cloudflare Worker 中。</div>
                <Form form={form} initialValues={defaultOssHostingConfig} layout="vertical" requiredMark={false}>
                    <Form.Item name="provider" label="托管方式">
                        <Select
                            options={[
                                { value: "aliyun-oss", label: "阿里云 OSS（签名直传）" },
                                { value: "cloudflare-r2", label: "Cloudflare R2 + Worker（推荐长期免费层）" },
                            ]}
                        />
                    </Form.Item>
                    {provider === "aliyun-oss" ? (
                        <Form.Item name="signatureEndpoint" label="签名接口" rules={[httpsUrlRule("请输入签名接口地址")]}>
                            <Input placeholder="https://api.example.com/oss/signature" />
                        </Form.Item>
                    ) : (
                        <>
                            <Form.Item name="r2WorkerEndpoint" label="Worker 地址" rules={[httpsUrlRule("请输入 Worker 地址")]}>
                                <Input placeholder="https://ly-space-r2-media.example.workers.dev" />
                            </Form.Item>
                            <Form.Item name="r2UploadToken" label="上传令牌" rules={[{ required: true, message: "请输入 Worker 上传令牌" }]}>
                                <Input.Password placeholder="与 Worker 的 UPLOAD_TOKEN 保持一致" autoComplete="off" />
                            </Form.Item>
                        </>
                    )}
                    <Form.Item name="publicBaseUrl" label="公网域名" rules={[httpsUrlRule("请输入公网域名")]}>
                        <Input placeholder={provider === "cloudflare-r2" ? "https://media.example.com" : "https://bucket.oss-cn-hangzhou.aliyuncs.com"} />
                    </Form.Item>
                    {provider === "aliyun-oss" ? (
                        <Form.Item name="objectPrefix" label="对象前缀">
                            <Input placeholder="ly-space/references" />
                        </Form.Item>
                    ) : null}
                </Form>
                <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500 dark:text-stone-400">
                    <Button type="primary" loading={saving} onClick={() => void handleSave()}>
                        保存设置
                    </Button>
                    <span>
                        {provider === "cloudflare-r2"
                            ? "R2 Worker 模板位于仓库 cloudflare/r2-media-worker；免费计划单个素材最大 100MB，生产环境请使用 R2 自定义域名。"
                            : "签名接口应返回 OSS PostObject 的 host、dir、policy 与临时签名字段；请勿填写长期 AccessKey。"}
                    </span>
                </div>
            </section>

            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-3 text-sm font-semibold">公网参考图 URL</div>
                <div className="mb-3 text-xs leading-5 text-stone-500 dark:text-stone-400">将公网 HTTPS 图片 URL 加入视频创作台参考图（Agnes 图生视频仅可使用服务端可访问的 HTTPS 图片地址）。</div>
                <Space.Compact className="w-full">
                    <Input value={publicImageUrl} placeholder="https://example.com/reference.png" onChange={(event) => setPublicImageUrl(event.target.value)} onPressEnter={() => void addPublicImageUrl()} />
                    <Button type="primary" onClick={() => void addPublicImageUrl()}>
                        加入参考图
                    </Button>
                </Space.Compact>
            </section>
        </div>
    );
}
