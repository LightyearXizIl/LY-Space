import { useState } from "react";
import { App } from "antd";

import { requestImageQuestion } from "@/services/api/image";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

/**
 * 提示词优化 hook：用文本模型（textModel 优先）流式优化提示词并回填。
 * 与生图/视频工作台 optimizePrompt 同源逻辑，供画布节点面板复用。
 */

export type PromptOptimizeKind = "image" | "video";

const OPTIMIZE_SYSTEM_PROMPTS: Record<PromptOptimizeKind, string> = {
    image: "你是专业的生图提示词优化专家。请优化用户给出的提示词，使其更具体、生动、可控（可补充主体、风格、构图、光线、氛围、画质等描述），只输出优化后的提示词本身，不要解释、不要引号、不要多余内容。",
    video: "你是专业的视频生成提示词优化专家。请优化用户给出的提示词，使其更具体、生动、可控（可补充镜头运动、主体动作、场景氛围、画面风格等描述），只输出优化后的提示词本身，不要解释、不要引号、不要多余内容。",
};

type UsePromptOptimizerOptions = {
    kind: PromptOptimizeKind;
    config: AiConfig;
    /** 取当前提示词文本（每次调用时最新值） */
    getText: () => string;
    /** 流式回填提示词文本 */
    setText: (text: string) => void;
    /** 未完成配置时打开配置对话框 */
    openConfigDialog?: (shouldPromptContinue?: boolean) => void;
    /** 自定义 system prompt（默认按 kind 取内置文案；生成配置节点需追加"保留 @[node:xxx] 引用标记"说明） */
    systemPrompt?: string;
};

export function usePromptOptimizer({ kind, config, getText, setText, openConfigDialog, systemPrompt }: UsePromptOptimizerOptions) {
    const { message } = App.useApp();
    const storeIsAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const [optimizing, setOptimizing] = useState(false);

    const optimize = async () => {
        const text = getText().trim();
        if (!text) {
            message.warning("请先输入提示词");
            return;
        }
        if (!storeIsAiConfigReady(config, config.textModel || config.model)) {
            message.warning("请先完成配置");
            openConfigDialog?.(true);
            return;
        }
        setOptimizing(true);
        try {
            let streamed = "";
            // requestImageQuestion 内部优先取 config.model
            const textConfig = { ...config, model: config.textModel || config.model };
            const answer = await requestImageQuestion(
                textConfig,
                [
                    { role: "system", content: systemPrompt ?? OPTIMIZE_SYSTEM_PROMPTS[kind] },
                    { role: "user", content: text },
                ],
                (delta) => {
                    // onDelta 为增量回调，按序累加并流式回填提示词
                    streamed += delta;
                    setText(streamed);
                },
            );
            setText(answer || streamed);
            message.success("提示词已优化");
        } catch (error) {
            message.error(error instanceof Error ? `提示词优化失败：${error.message}` : "提示词优化失败");
        } finally {
            setOptimizing(false);
        }
    };

    return { optimizing, optimize };
}
