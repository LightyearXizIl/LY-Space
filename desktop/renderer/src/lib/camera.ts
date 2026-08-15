export type CameraGroupKey = "angle" | "shot" | "distance" | "lens" | "position";

export type CameraSelection = Partial<Record<CameraGroupKey, string>>;

export type CameraGroup = {
    key: CameraGroupKey;
    label: string;
    options: string[];
};

export const CAMERA_GROUPS: CameraGroup[] = [
    { key: "angle", label: "视角", options: ["自动", "正面", "45度", "侧面", "背面", "俯视", "仰视"] },
    { key: "shot", label: "景别", options: ["自动", "特写", "半身/中景", "全身", "产品细节", "场景", "远景"] },
    { key: "distance", label: "距离", options: ["自动", "近", "中", "远"] },
    { key: "lens", label: "镜头", options: ["自动", "广角", "标准", "长焦", "微距"] },
    { key: "position", label: "机位", options: ["自动", "平视", "高机位", "低机位"] },
];

const SEPARATOR = "[，,、。；;：:\\s]";

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cameraTextPresent(prompt: string, text: string): boolean {
    return Boolean(text) && new RegExp(`(^|${SEPARATOR})${escapeRegExp(text)}(?=$|${SEPARATOR})`).test(prompt);
}

export function normalizeCameraSelection(selection?: CameraSelection): CameraSelection {
    return CAMERA_GROUPS.reduce<CameraSelection>((next, group) => {
        const option = selection?.[group.key];
        if (option && option !== "自动" && group.options.includes(option)) next[group.key] = option;
        return next;
    }, {});
}

export function toggleCameraSelection(selection: CameraSelection | undefined, group: CameraGroup, option: string): CameraSelection {
    const next = normalizeCameraSelection(selection);
    if (option === "自动" || next[group.key] === option) delete next[group.key];
    else next[group.key] = option;
    return next;
}

export function cameraSelectionEntries(selection?: CameraSelection) {
    const normalized = normalizeCameraSelection(selection);
    return CAMERA_GROUPS.flatMap((group) => {
        const value = normalized[group.key];
        return value ? [{ label: group.label, value }] : [];
    });
}

export function formatCameraSelection(selection?: CameraSelection) {
    const entries = cameraSelectionEntries(selection);
    return entries.length ? entries.map((item) => `${item.label}：${item.value}`).join(" · ") : "自动";
}

export function buildCameraPrompt(prompt: string, selection?: CameraSelection): string {
    let next = prompt;
    for (const { value } of cameraSelectionEntries(selection)) {
        if (cameraTextPresent(next, value)) continue;
        const trimmed = next.trimEnd();
        next = !trimmed ? value : new RegExp(`${SEPARATOR}$`).test(trimmed) ? trimmed + value : `${trimmed}，${value}`;
    }
    return next;
}
