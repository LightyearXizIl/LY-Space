import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchChannelBalance } from "@/services/api/balance";
import { createModelChannel } from "@/stores/use-config-store";

afterEach(() => {
    vi.restoreAllMocks();
});

function grsaiChannel(id: string) {
    return createModelChannel({
        id,
        name: "GRS AI",
        baseUrl: "https://grsai.dakka.com.cn/v1",
        apiKey: "sk-test-key",
        apiFormat: "grsai",
        models: [{ name: "gpt-image-2", capability: "image" }],
    });
}

describe("渠道余额查询", () => {
    it("GRS AI 优先读取账户积分接口，而不是把 API Key 积分 0 当成账户余额", async () => {
        const get = vi.spyOn(axios, "get").mockResolvedValue({ data: { data: { credits: 123.45 } } } as never);
        const post = vi.spyOn(axios, "post");

        const result = await fetchChannelBalance(grsaiChannel("grs-account"), { enabled: true, mode: "grsai", path: "/wallet", intervalSec: 60 });

        expect(result).toMatchObject({ amount: 123.45, probe: "grsai-account-credits" });
        expect(get).toHaveBeenCalledWith(
            "https://grsai.dakka.com.cn/client/common/getCredits?apikey=sk-test-key",
            expect.objectContaining({ headers: {}, timeout: 15000 }),
        );
        expect(post).not.toHaveBeenCalled();
    });

    it("账户积分接口不可用时回退到 API Key 积分接口，并保留合法的 0", async () => {
        vi.spyOn(axios, "get").mockRejectedValue(new Error("not supported"));
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { credits: 0 } } } as never);

        const result = await fetchChannelBalance(grsaiChannel("grs-fallback"), { enabled: true, mode: "grsai", path: "/wallet", intervalSec: 60 });

        expect(result).toMatchObject({ amount: 0, probe: "grsai-apikey-credits" });
        expect(post).toHaveBeenCalledWith(
            "https://grsai.dakka.com.cn/client/openapi/getAPIKeyCredits",
            { apiKey: "sk-test-key" },
            expect.objectContaining({ headers: { "Content-Type": "application/json" }, timeout: 15000 }),
        );
    });
});
