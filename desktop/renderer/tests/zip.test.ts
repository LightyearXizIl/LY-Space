import { describe, expect, it } from "vitest";

import { createZip, readZip } from "@/lib/zip";

describe("ZIP 读取校验", () => {
    it("不对 ZIP 字节大小设置人工上限", async () => {
        const zip = await createZip([{ name: "projects.json", data: "{}" }]);
        await expect(readZip(zip)).resolves.toBeInstanceOf(Map);
    });

    it("继续拒绝非法路径和超过 5000 个文件的压缩包", async () => {
        const illegal = await createZip([{ name: "../projects.json", data: "{}" }]);
        await expect(readZip(illegal)).rejects.toThrow("压缩包包含非法路径");
        const tooMany = await createZip(Array.from({ length: 5001 }, (_, index) => ({ name: `files/${index}.txt`, data: "" })));
        await expect(readZip(tooMany)).rejects.toThrow("压缩包文件数量过多");
    });
});
