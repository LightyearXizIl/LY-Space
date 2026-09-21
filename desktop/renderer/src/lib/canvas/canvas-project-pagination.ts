export const CANVAS_PROJECTS_PER_PAGE = 15;
export const CANVAS_PROJECT_PAGINATION_WINDOW_SIZE = 3;

export function getCanvasProjectPageCount(total: number) {
    return Math.max(1, Math.ceil(total / CANVAS_PROJECTS_PER_PAGE));
}

export function shouldShowCanvasProjectPagination(total: number) {
    return total > 0;
}

export function getCanvasProjectPageWindow(page: number, total: number) {
    const pageCount = getCanvasProjectPageCount(total);
    const current = clampCanvasProjectPage(page, total);
    const start = Math.min(current, Math.max(1, pageCount - CANVAS_PROJECT_PAGINATION_WINDOW_SIZE + 1));
    return Array.from({ length: Math.min(CANVAS_PROJECT_PAGINATION_WINDOW_SIZE, pageCount - start + 1) }, (_, index) => start + index);
}

export function clampCanvasProjectPage(page: number, total: number) {
    return Math.min(Math.max(1, page), getCanvasProjectPageCount(total));
}

export function getCanvasProjectPage<T>(projects: T[], page: number) {
    const current = clampCanvasProjectPage(page, projects.length);
    const start = (current - 1) * CANVAS_PROJECTS_PER_PAGE;
    return projects.slice(start, start + CANVAS_PROJECTS_PER_PAGE);
}
