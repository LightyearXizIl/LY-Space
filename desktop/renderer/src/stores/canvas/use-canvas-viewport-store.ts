import { create } from "zustand";

import type { ViewportTransform } from "@/types/canvas";

// 画布视口变换的共享轻量状态:渲染期组件(如 CanvasNode)通过 getState() 读取,
// 避免 viewport prop 变化(缩放)击穿 React.memo 导致全部节点重渲染。
// 注意:仅供「读取最新值」使用,不要用 selector 订阅它(订阅会失去 memo 收益)。
type CanvasViewportStore = {
    viewport: ViewportTransform;
    setViewport: (viewport: ViewportTransform) => void;
};

export const useCanvasViewportStore = create<CanvasViewportStore>((set) => ({
    viewport: { x: 0, y: 0, k: 1 },
    setViewport: (viewport) => set({ viewport }),
}));
