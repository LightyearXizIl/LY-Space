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
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await trackWrite(localforage.setItem(name, value));
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await trackWrite(localforage.removeItem(name));
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
