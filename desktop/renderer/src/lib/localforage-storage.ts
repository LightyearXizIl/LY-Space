import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { trackWrite } from "@/services/desktop-storage";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        const fallback = window.localStorage.getItem(`${name}:fallback`);
        if (fallback !== null) return fallback;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return null;
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await trackWrite(localforage.setItem(name, value));
            window.localStorage.removeItem(`${name}:fallback`);
        } catch {
            window.localStorage.setItem(`${name}:fallback`, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await trackWrite(localforage.removeItem(name));
        } catch {
        }
        window.localStorage.removeItem(`${name}:fallback`);
    },
};
