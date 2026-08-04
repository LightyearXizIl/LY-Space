import localforage from "localforage";
import { nanoid } from "nanoid";

import type { RawPrompt } from "./prompt-source-runtime";

const personalPromptStore = localforage.createInstance({ name: "infinite-canvas", storeName: "personal_prompts" });
const PERSONAL_PROMPTS_KEY = "personal_prompts";

/** 新建一条个人提示词：补齐 RawPrompt 字段，id 与时间戳自动生成。 */
export function createPersonalPrompt(value: Partial<RawPrompt> & { title: string; prompt: string }): RawPrompt {
    const now = new Date().toISOString();
    return {
        id: value.id?.trim() || nanoid(),
        title: value.title.trim(),
        prompt: value.prompt.trim(),
        description: (value.description || "").trim(),
        coverUrl: (value.coverUrl || "").trim(),
        referenceImageUrls: Array.isArray(value.referenceImageUrls) ? value.referenceImageUrls : [],
        tags: Array.isArray(value.tags) ? value.tags.map((tag) => tag.trim()).filter(Boolean) : [],
        preview: (value.preview || "").trim(),
        createdAt: value.createdAt || now,
        updatedAt: now,
        author: value.author,
        sourceUrl: value.sourceUrl,
        imageMode: value.imageMode,
        imageModel: value.imageModel,
        imageSize: value.imageSize,
        imageCount: value.imageCount,
    };
}

export async function fetchPersonalPrompts(): Promise<RawPrompt[]> {
    const items = await personalPromptStore.getItem<RawPrompt[]>(PERSONAL_PROMPTS_KEY);
    return Array.isArray(items) ? items : [];
}

/** 按 id 新增或更新一条个人提示词，返回保存后的完整列表。 */
export async function savePersonalPrompt(prompt: RawPrompt): Promise<RawPrompt[]> {
    const items = await fetchPersonalPrompts();
    const exists = items.some((item) => item.id === prompt.id);
    const next = exists ? items.map((item) => (item.id === prompt.id ? prompt : item)) : [...items, prompt];
    await personalPromptStore.setItem(PERSONAL_PROMPTS_KEY, next);
    return next;
}

export async function removePersonalPrompt(id: string): Promise<RawPrompt[]> {
    const items = await fetchPersonalPrompts();
    const next = items.filter((item) => item.id !== id);
    await personalPromptStore.setItem(PERSONAL_PROMPTS_KEY, next);
    return next;
}
