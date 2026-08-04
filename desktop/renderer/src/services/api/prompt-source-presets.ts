import { nanoid } from "nanoid";

export type PromptSource = {
    id: string;
    name: string;
    url: string;
    homepage: string;
    enabled: boolean;
    builtIn: boolean;
};

export const PROMPT_REGISTRY_HOMEPAGE = "https://github.com/yukkcat/image-prompts";
const PROMPT_REGISTRY_SOURCE_BASE = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources";

/** 个人词库来源 ID：本地存储的特殊内置来源，不走远程拉取。 */
export const PERSONAL_SOURCE_ID = "personal";

export function createPromptSource(source?: Partial<PromptSource>): PromptSource {
    return {
        id: source?.id?.trim() || nanoid(),
        name: source?.name?.trim() || "新来源",
        url: source?.url?.trim() || "",
        homepage: source?.homepage?.trim() || "",
        enabled: source?.enabled ?? true,
        builtIn: source?.builtIn ?? false,
    };
}

export const DEFAULT_PROMPT_SOURCES: PromptSource[] = [
    { id: PERSONAL_SOURCE_ID, name: "个人词库", url: "", homepage: "", enabled: true, builtIn: true },
    registrySource("banana-prompt-quicker", "Banana Prompt Quicker", "https://glidea.github.io/banana-prompt-quicker/"),
    registrySource("davidwu-gpt-image2-prompts", "DavidWu GPT Image 2", "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts"),
    registrySource("awesome-gpt-image", "Awesome GPT Image", "https://github.com/ZeroLu/awesome-gpt-image"),
    registrySource("awesome-gpt4o-image-prompts", "Awesome GPT-4o", "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts"),
    registrySource("youmind-gpt-image-2", "YouMind GPT Image 2", "https://github.com/YouMind-OpenLab/awesome-gpt-image-2"),
    registrySource("youmind-nano-banana-pro", "YouMind Nano Banana Pro", "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts"),
];

function registrySource(id: string, name: string, homepage: string): PromptSource {
    return { id, name, url: `${PROMPT_REGISTRY_SOURCE_BASE}/${id}.json`, homepage, enabled: true, builtIn: true };
}
