export const CANVAS_PROJECTS_PER_PAGE = 15;

export function getCanvasProjectPageCount(total: number) {
    return Math.max(1, Math.ceil(total / CANVAS_PROJECTS_PER_PAGE));
}

export function shouldShowCanvasProjectPagination(total: number) {
    return total > 0;
}

export function clampCanvasProjectPage(page: number, total: number) {
    return Math.min(Math.max(1, page), getCanvasProjectPageCount(total));
}

export function getCanvasProjectPage<T>(projects: T[], page: number) {
    const current = clampCanvasProjectPage(page, projects.length);
    const start = (current - 1) * CANVAS_PROJECTS_PER_PAGE;
    return projects.slice(start, start + CANVAS_PROJECTS_PER_PAGE);
}
