// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReferenceImage } from "@/types/image";

const mocks = vi.hoisted(() => ({ local: vi.fn(), hosted: vi.fn(), recent: vi.fn(), message: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/services/image-storage", () => ({ uploadImage: mocks.local }));
vi.mock("@/services/media-hosting", () => ({
    REFERENCE_IMAGE_MIME_TYPES: ["image/png", "image/jpeg", "image/webp"],
    validateReferenceImageFile: vi.fn(), uploadReferenceImage: mocks.hosted,
    loadRecentReferenceUploads: async () => [], saveRecentReferenceUpload: mocks.recent,
    ReferenceHostingConfigurationError: class extends Error {},
}));
vi.mock("antd", () => {
    const Image = Object.assign((props: any) => <img {...props} />, { PreviewGroup: ({ children }: any) => <>{children}</> });
    return {
        App: { useApp: () => ({ message: mocks.message }) }, Image,
        Button: ({ children, icon, size, danger, ...props }: any) => <button {...props}>{icon}{children}</button>,
        Input: ({ onPressEnter, ...props }: any) => <input {...props} />,
        Tooltip: ({ children }: any) => <>{children}</>,
        Alert: ({ message, description, action }: any) => <div role="alert">{message}{description}{action}</div>,
    };
});
import { ReferenceImageUploader } from "@/components/reference-image-uploader";
import { ReferenceHostingConfigurationError } from "@/services/media-hosting";

let root: Root;
let container: HTMLDivElement;
let references: ReferenceImage[];
function Harness({ hosted = false }: { hosted?: boolean }) {
    const [items, setItems] = useState<ReferenceImage[]>([]);
    references = items;
    return <ReferenceImageUploader references={items} setReferences={setItems} limit={9} requiresPublicUrl={hosted} onOpenSettings={() => {}} />;
}
beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("不应联网"); }));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
    mocks.local.mockResolvedValue({ url: "blob:stored", storageKey: "image:local", mimeType: "image/png" });
    mocks.hosted.mockResolvedValue({ url: "https://example.com/ref.png", key: "ref.png" });
    mocks.recent.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
async function render(hosted = false) {
    await act(async () => root.render(<Harness hosted={hosted} />));
}
async function addFiles(count = 1) {
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: Array.from({ length: count }, (_, index) => new File(["image"], `${index}.png`, { type: "image/png" })) });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

it("无 OSS 时本地图片成功加入并保留持久化键，不复制临时链接", async () => {
    await render();
    await addFiles(2);
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({ dataUrl: "blob:stored", storageKey: "image:local" });
    expect(container.textContent).toContain("2 / 9");
    expect(container.querySelector('[aria-label="复制图片链接"]')).toBeNull();
    expect(mocks.hosted).not.toHaveBeenCalled();
    expect(mocks.recent).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});

it("公网链接接口保留上传路径和可复制链接", async () => {
    await render(true);
    await addFiles();
    expect(mocks.hosted).toHaveBeenCalledOnce();
    expect(mocks.local).not.toHaveBeenCalled();
    expect(references[0].url).toBe("https://example.com/ref.png");
    expect(container.querySelector('[aria-label="复制图片链接"]')).not.toBeNull();
});

it("托管失败后切到本地模式可重试加入，不继续要求 OSS", async () => {
    mocks.hosted.mockRejectedValueOnce(new ReferenceHostingConfigurationError("需要托管"));
    await render(true);
    await addFiles();
    expect(references).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await render(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => (container.querySelector('[aria-label="重试上传"]') as HTMLButtonElement).click());
    expect(references).toHaveLength(1);
    expect(mocks.hosted).toHaveBeenCalledOnce();
    expect(mocks.local).toHaveBeenCalledOnce();
});

it("移除尚在处理的图片后，完成回调不得将它重新加入", async () => {
    let finish!: (value: unknown) => void;
    mocks.local.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render();
    await addFiles();
    await act(async () => (Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "清空")!).click());
    await act(async () => finish({ url: "blob:stored", storageKey: "image:local", mimeType: "image/png" }));
    expect(references).toHaveLength(0);
});
