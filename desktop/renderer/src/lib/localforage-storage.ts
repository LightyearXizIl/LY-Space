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
        try {
            const primary = await localforage.getItem<string>(name);
            return primary || fallback;
        } catch (error) {
            if (fallback !== null) return fallback;
            throw error;
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await trackWrite(localforage.setItem(name, value));
            window.localStorage.removeItem(`${name}:fallback`);
        } catch (error) {
            window.localStorage.setItem(`${name}:fallback`, value);
            if (!window.localStorage.getItem(`${name}:fallback`)) throw error;
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
