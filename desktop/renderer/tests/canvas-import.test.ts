import { describe, expect, it } from "vitest";

import { areCanvasImportBlobsEqual, CanvasImportError, readCanvasImportPackage, uniqueCanvasImportAssets } from "@/lib/canvas/canvas-import";

function packageJson(files: unknown[] = []) {
    return new Blob([JSON.stringify({ app: "infinite-canvas", version: 3, exportedAt: "2026-09-21T00:00:00.000Z", projects: [{ project: { title: "测试画布" }, files }] })], { type: "application/json" });
}

describe("画布导入包预检", () => {
    it("读取完整的 v3 画布包", async () => {
        const asset = new Blob(["image-data"], { type: "image/png" });
        const zip = new Map([
            ["projects.json", packageJson([{ storageKey: "image:test", path: "projects/test/files/test.png", mimeType: "image/png", bytes: asset.size }])],
            ["projects/test/files/test.png", asset],
        ]);

        await expect(readCanvasImportPackage(zip)).resolves.toMatchObject({ projects: [{ project: { title: "测试画布" } }], assets: [{ storageKey: "image:test", blob: asset }] });
    });

    it("拒绝错误清单、缺失素材和尺寸不一致", async () => {
        await expect(readCanvasImportPackage(new Map([["projects.json", new Blob(["{"])]]))).rejects.toThrow(CanvasImportError);
        await expect(readCanvasImportPackage(new Map([["projects.json", packageJson([{ storageKey: "image:test", path: "missing.png", mimeType: "image/png", bytes: 1 }])]]))).rejects.toThrow("画布包缺少素材文件");
        await expect(
            readCanvasImportPackage(
                new Map([
                    ["projects.json", packageJson([{ storageKey: "image:test", path: "test.png", mimeType: "image/png", bytes: 2 }])],
                    ["test.png", new Blob(["x"])],
                ]),
            ),
        ).rejects.toThrow("画布素材文件尺寸不一致");
    });

    it("仅复用字节完全相同的同键素材", async () => {
        await expect(areCanvasImportBlobsEqual(new Blob(["same"]), new Blob(["same"]))).resolves.toBe(true);
        await expect(areCanvasImportBlobsEqual(new Blob(["same"]), new Blob(["different"]))).resolves.toBe(false);
    });

    it("复用同键同内容素材并拒绝同键不同内容", async () => {
        const first = { storageKey: "image:duplicate", path: "first.png", mimeType: "image/png", bytes: 1, blob: new Blob(["a"]) };
        const same = { ...first, path: "same.png", blob: new Blob(["a"]) };
        const different = { ...first, path: "different.png", blob: new Blob(["b"]) };

        await expect(uniqueCanvasImportAssets([first, same])).resolves.toHaveLength(1);
        await expect(uniqueCanvasImportAssets([first, different])).rejects.toThrow("画布包中存在内容不同的同键素材");
    });
});
