import { useEffect, useState } from "react";
import { App, Button, Form, Input, Space } from "antd";

import { loadOssHostingConfig, saveOssHostingConfig, type OssHostingConfig } from "@/services/oss-hosting";
import { enqueueReferenceHandoff } from "@/services/reference-handoff";

export function OssSettingsPanel() {
    const { message } = App.useApp();
    const [form] = Form.useForm<OssHostingConfig>();
    const [saving, setSaving] = useState(false);
    const [publicImageUrl, setPublicImageUrl] = useState("");

    useEffect(() => {
        void loadOssHostingConfig().then((config) => form.setFieldsValue(config));
    }, [form]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const values = await form.validateFields();
            await saveOssHostingConfig(values);
            message.success("OSS 设置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "OSS 设置保存失败");
        } finally {
            setSaving(false);
        }
    };

    const addPublicImageUrl = async () => {
        const url = publicImageUrl.trim();
        if (!/^https:\/\//i.test(url)) {
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
                <div className="mb-3 text-sm font-semibold">阿里云 OSS 托管</div>
                <div className="mb-3 text-xs leading-5 text-stone-500 dark:text-stone-400">
                    配置后，视频创作台的本地参考图会优先通过 OSS 转为公网 HTTPS 地址（安全 STS/签名直传），适配 Agnes 等只接受公网图片的服务。
                </div>
                <Form form={form} layout="vertical" requiredMark={false}>
                    <Form.Item name="signatureEndpoint" label="签名接口" rules={[{ required: true, message: "请输入签名接口地址" }]}>
                        <Input placeholder="https://api.example.com/oss/signature" />
                    </Form.Item>
                    <Form.Item name="publicBaseUrl" label="公网域名" rules={[{ required: true, message: "请输入公网域名" }]}>
                        <Input placeholder="https://bucket.oss-cn-hangzhou.aliyuncs.com" />
                    </Form.Item>
                    <Form.Item name="objectPrefix" label="对象前缀">
                        <Input placeholder="ly-space/references" />
                    </Form.Item>
                </Form>
                <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500 dark:text-stone-400">
                    <Button type="primary" loading={saving} onClick={() => void handleSave()}>
                        保存设置
                    </Button>
                    <span>签名接口应返回 OSS PostObject 的 host、dir、policy 与临时签名字段；请勿填写长期 AccessKey。</span>
                </div>
            </section>

            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-3 text-sm font-semibold">公网参考图 URL</div>
                <div className="mb-3 text-xs leading-5 text-stone-500 dark:text-stone-400">
                    将公网 HTTPS 图片 URL 加入视频创作台参考图（Agnes 图生视频仅可使用服务端可访问的 HTTPS 图片地址）。
                </div>
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
