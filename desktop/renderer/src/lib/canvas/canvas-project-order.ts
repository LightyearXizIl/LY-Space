export type CanvasProjectOrderItem = { id: string };

export function shouldInsertProjectBefore(clientX: number, rect: Pick<DOMRect, "left" | "width">) {
    return clientX < rect.left + rect.width / 2;
}

export function reorderCanvasProjects<T extends CanvasProjectOrderItem>(projects: T[], id: string, targetId: string, before: boolean) {
    const from = projects.findIndex((project) => project.id === id);
    const target = projects.findIndex((project) => project.id === targetId);
    if (from < 0 || target < 0 || from === target) return projects;
    const next = [...projects];
    const [moved] = next.splice(from, 1);
    let to = next.findIndex((project) => project.id === targetId);
    if (!before) to += 1;
    next.splice(to, 0, moved);
    return next;
}
