import localforage from "localforage";
import { nanoid } from "nanoid";
import { trackWrite } from "@/services/desktop-storage";

export type PendingReferenceHandoff = {
    id: string;
    target: "image" | "video";
    storageKey: string;
    name: string;
    type: string;
    width: number;
    height: number;
    createdAt: number;
    /** 公网 URL 参考图：直接加入参考图，无需本地存储解析（storageKey 留空） */
    url?: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "reference_handoffs" });

export async function enqueueReferenceHandoff(input: Omit<PendingReferenceHandoff, "id" | "createdAt">) {
    const handoff = { ...input, id: nanoid(), createdAt: Date.now() };
    await trackWrite(store.setItem(handoff.id, handoff));
    return handoff;
}

export async function getReferenceHandoffs(target: PendingReferenceHandoff["target"]) {
    const items: PendingReferenceHandoff[] = [];
    await store.iterate<PendingReferenceHandoff, void>((value) => {
        if (value.target === target) items.push(value);
    });
    return items.sort((left, right) => left.createdAt - right.createdAt);
}

export async function acknowledgeReferenceHandoff(id: string) {
    await trackWrite(store.removeItem(id));
}
