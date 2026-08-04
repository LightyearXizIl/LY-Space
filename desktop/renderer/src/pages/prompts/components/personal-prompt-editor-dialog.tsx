import { useEffect } from "react";
import { Form, Input, Modal, Select } from "antd";

import { createPersonalPrompt, savePersonalPrompt } from "@/services/api/personal-prompts";
import type { RawPrompt } from "@/services/api/prompt-source-runtime";

type FormValues = {
    title: string;
    prompt: string;
    description?: string;
    tags?: string[];
    coverUrl?: string;
};

export function PersonalPromptEditorDialog({ open, prompt, onClose, onSaved }: { open: boolean; prompt: RawPrompt | null; onClose: () => void; onSaved: () => void }) {
    const [form] = Form.useForm<FormValues>();

    useEffect(() => {
        if (!open) return;
        if (prompt) {
            form.setFieldsValue({ title: prompt.title, prompt: prompt.prompt, description: prompt.description || "", tags: prompt.tags || [], coverUrl: prompt.coverUrl || "" });
        } else {
            form.resetFields();
        }
    }, [form, open, prompt]);

    const handleOk = async () => {
        const values = await form.validateFields();
        await savePersonalPrompt(createPersonalPrompt({ ...values, id: prompt?.id, createdAt: prompt?.createdAt }));
        onSaved();
    };

    return (
        <Modal title={prompt ? "编辑提示词" : "新增提示词"} open={open} onCancel={onClose} onOk={() => void handleOk()} okText="保存" cancelText="取消" width={640}>
            <Form form={form} layout="vertical" requiredMark={false} className="mt-2">
                <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                    <Input placeholder="提示词标题" maxLength={100} />
                </Form.Item>
                <Form.Item name="prompt" label="提示词内容" rules={[{ required: true, message: "请输入提示词内容" }]}>
                    <Input.TextArea placeholder="粘贴或输入提示词内容" autoSize={{ minRows: 4, maxRows: 10 }} />
                </Form.Item>
                <Form.Item name="description" label="描述">
                    <Input.TextArea placeholder="可选，提示词的简短说明" autoSize={{ minRows: 2, maxRows: 4 }} />
                </Form.Item>
                <Form.Item name="tags" label="标签">
                    <Select mode="tags" placeholder="输入后回车添加标签" open={false} suffixIcon={null} />
                </Form.Item>
                <Form.Item name="coverUrl" label="封面图片 URL" extra="可选，留空时显示默认图标">
                    <Input placeholder="https://example.com/cover.png" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
