import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, App, Button, Checkbox, Modal, Pagination, Spin } from "antd";
import { Download, FileUp, Plus, RefreshCw } from "lucide-react";

import { readZip } from "@/lib/zip";
import { deleteStoredMedia, getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { deleteStoredImages, getImageBlob, setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { areCanvasImportBlobsEqual, CanvasImportError, readCanvasImportPackage, uniqueCanvasImportAssets } from "@/lib/canvas/canvas-import";
import { shouldInsertProjectBefore } from "@/lib/canvas/canvas-project-order";
import { CANVAS_PROJECTS_PER_PAGE, clampCanvasProjectPage, getCanvasProjectPage, shouldShowCanvasProjectPagination } from "@/lib/canvas/canvas-project-pagination";
import { logAppEvent } from "@/services/app-logger";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const ZIP_READ_ERROR_MESSAGES: Record<string, string> = {
    压缩包文件数量过多: "压缩包文件数量超过 5000 个，无法导入",
    压缩包包含非法路径: "压缩包包含非法路径，无法导入",
};

export default function CanvasPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const hydrationError = useCanvasStore((state) => state.hydrationError);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const recoverProjects = useCanvasStore((state) => state.recoverProjects);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const reorderProjects = useCanvasStore((state) => state.reorderProjects);
    // 拖动排序状态:正在拖的项目 id + 目标卡片的插入位置
    const [dragProjectId, setDragProjectId] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);
    const [recoveryScan, setRecoveryScan] = useState<CanvasRecoveryScan | null>(null);
    const [recoveryOpen, setRecoveryOpen] = useState(false);
    const [recoveryScanning, setRecoveryScanning] = useState(false);
    const [recoveryProgress, setRecoveryProgress] = useState<CanvasRecoveryProgress | null>(null);
    const [recoveryApplying, setRecoveryApplying] = useState(false);
    const [selectedRecoveryIds, setSelectedRecoveryIds] = useState<string[]>([]);
    const [restoreConfiguration, setRestoreConfiguration] = useState(false);
    const [page, setPage] = useState(1);
    const currentPage = clampCanvasProjectPage(page, projects.length);
    const visibleProjects = getCanvasProjectPage(projects, currentPage);

    const scanRecovery = useCallback(async () => {
        const desktop = window.lySpaceDesktop;
        if (!desktop) return;
        // 手动触发：立即打开对话框显示扫描进度，扫描期间用户可关闭（结果不自动重开弹窗）。
        setRecoveryScan(null);
        setRecoveryProgress(null);
        setRecoveryOpen(true);
        setRecoveryScanning(true);
        try {
            const scan = await desktop.scanCanvasRecovery(projects);
            setRecoveryScan(scan);
            setSelectedRecoveryIds(scan.projects.map((project) => project.id));
            setRestoreConfiguration(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法扫描本机画布备份");
            setRecoveryOpen(false);
        } finally {
            setRecoveryScanning(false);
        }
    }, [message, projects]);

    useEffect(() => {
        const desktop = window.lySpaceDesktop;
        if (!desktop?.onCanvasRecoveryProgress) return;
        return desktop.onCanvasRecoveryProgress((progress) => setRecoveryProgress(progress));
    }, []);

    const applyRecovery = async () => {
        if (!recoveryScan || !selectedRecoveryIds.length || !window.lySpaceDesktop) return;
        setRecoveryApplying(true);
        try {
            const result = await window.lySpaceDesktop.applyCanvasRecovery(projects, { scanId: recoveryScan.scanId, projectIds: selectedRecoveryIds, restoreConfiguration });
            await recoverProjects(result.projects as CanvasProject[]);
            if (result.configuration?.config || result.configuration?.webdav) {
                useConfigStore.setState((state) => ({ config: { ...state.config, ...(result.configuration?.config as object) }, webdav: { ...state.webdav, ...(result.configuration?.webdav as object) } }));
            }
            setRecoveryOpen(false);
            setRecoveryScan(null);
            message.success(`已恢复 ${result.recovered} 个画布`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "恢复画布失败，当前数据未被覆盖");
        } finally {
            setRecoveryApplying(false);
        }
    };

    const exportRecoveryDiagnostics = async () => {
        if (!recoveryScan || !window.lySpaceDesktop) return;
        try {
            const bytes = new TextEncoder().encode(JSON.stringify(recoveryScan.diagnostics, null, 2)).buffer as ArrayBuffer;
            const result = await window.lySpaceDesktop.saveFileDialog({ title: "导出画布恢复诊断", defaultPath: "ly-space-canvas-recovery-diagnostic.json", bytes, filters: [{ name: "JSON", extensions: ["json"] }] });
            if (!result.canceled) message.success("已导出不含本机路径和项目内容的恢复诊断");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出恢复诊断失败");
        }
    };

    const clearDragState = () => {
        setDragProjectId(null);
        setDropTarget(null);
    };

    const handleCardDragStart = (event: DragEvent<HTMLDivElement>, id: string) => {
        // 从按钮/输入框(勾选、重命名、操作图标)上不触发拖动
        if ((event.target as HTMLElement).closest("button, input, a")) return;
        setDragProjectId(id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
    };
    const handleCardDragOver = (event: DragEvent<HTMLDivElement>, id: string) => {
        if (!dragProjectId || dragProjectId === id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const before = shouldInsertProjectBefore(event.clientX, rect);
        const next = { id, before };
        setDropTarget((current) => (current?.id === id && current.before === before ? current : next));
    };
    const handleCardDrop = (event: DragEvent<HTMLDivElement>, id: string) => {
        event.preventDefault();
        const before = shouldInsertProjectBefore(event.clientX, event.currentTarget.getBoundingClientRect());
        if (dragProjectId && dragProjectId !== id) {
            reorderProjects(dragProjectId, id, before);
            logAppEvent({ category: "operation", message: "调整画布库排序", details: { position: before ? "before" : "after" } });
        }
        clearDragState();
    };

    const enterProject = (id: string) => {
        navigate(`/canvas/${id}`);
    };
    const createAndEnter = () => enterProject(createProject(`无限画布 ${projects.length + 1}`));
    const importCanvas = async (file?: File) => {
        if (!file) return;
        const addedImages: string[] = [];
        const addedMedia: string[] = [];
        try {
            let zip: Map<string, Blob>;
            try {
                zip = await readZip(file);
            } catch (error) {
                const reason = error instanceof Error ? ZIP_READ_ERROR_MESSAGES[error.message] : undefined;
                throw new CanvasImportError(reason || "无法读取画布压缩包，请确认文件未损坏");
            }
            const data = await readCanvasImportPackage(zip);
            const assetsToWrite = [];
            for (const item of await uniqueCanvasImportAssets(data.assets)) {
                const image = item.storageKey.startsWith("image:");
                const existing = await (image ? getImageBlob(item.storageKey) : getMediaBlob(item.storageKey));
                if (existing && !(await areCanvasImportBlobsEqual(existing, item.blob))) throw new CanvasImportError("导入素材与本机已有素材冲突，未覆盖原素材");
                if (!existing) assetsToWrite.push(item);
            }
            for (const item of assetsToWrite) {
                const image = item.storageKey.startsWith("image:");
                try {
                    await (image ? setImageBlob(item.storageKey, item.blob) : setMediaBlob(item.storageKey, item.blob));
                } catch {
                    throw new CanvasImportError("素材保存失败，请检查可用磁盘空间后重试");
                }
                (image ? addedImages : addedMedia).push(item.storageKey);
            }
            data.projects.forEach((item) => importProject(item.project));
            setPage(1);
            message.success(`已导入 ${data.projects.length} 个画布`);
        } catch (error) {
            try {
                await Promise.all([deleteStoredImages(addedImages), deleteStoredMedia(addedMedia)]);
            } catch {
                // 素材存储不可用时优先保留原始导入错误，不掩盖用户可操作的失败原因。
            }
            message.error(error instanceof CanvasImportError ? error.message : "导入失败，请稍后重试");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">画布库</p>
                        <h1 className="mt-3 text-3xl font-semibold">无限画布</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button
                                    disabled={!hydrated}
                                    icon={<Download className="size-4" />}
                                    onClick={() =>
                                        void exportCanvasProjects(
                                            projects.filter((project) => selectedIds.includes(project.id)),
                                            `无限画布-${selectedIds.length}个项目`,
                                        )
                                    }
                                >
                                    导出选中
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                删除全部
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            导入画布
                        </Button>
                        <Button disabled={!hydrated || recoveryScanning} icon={<RefreshCw className={`size-4 ${recoveryScanning ? "animate-spin" : ""}`} />} onClick={() => void scanRecovery()}>
                            恢复画布
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </div>
                </header>
                {hydrationError ? <Alert type="error" showIcon message="画布数据暂时无法读取" description="为防止空数据覆盖原项目，已停止新建、删除和编辑。请使用检测到的恢复备份，或联系支持并保留本机数据目录。" /> : null}

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">正在加载画布...</section>
                ) : projects.length ? (
                    <>
                        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                            {visibleProjects.map((project) => {
                                const dragging = dragProjectId === project.id;
                                const dropSide = dropTarget?.id === project.id ? (dropTarget.before ? "before" : "after") : null;
                                return (
                                    <div
                                        key={project.id}
                                        draggable={hydrated}
                                        title="拖动卡片可自定义排序"
                                        onDragStart={(event) => handleCardDragStart(event, project.id)}
                                        onDragOver={(event) => handleCardDragOver(event, project.id)}
                                        onDrop={(event) => handleCardDrop(event, project.id)}
                                        onDragEnd={clearDragState}
                                        className={dragging ? "opacity-40" : undefined}
                                        style={dropSide ? { boxShadow: `inset ${dropSide === "before" ? "3px" : "-3px"} 0 0 0 #2f80ff` } : undefined}
                                    >
                                        <CanvasProjectCard project={project} />
                                    </div>
                                );
                            })}
                        </div>
                        {shouldShowCanvasProjectPagination(projects.length) ? (
                            <div className="flex justify-center">
                                <Pagination current={currentPage} pageSize={CANVAS_PROJECTS_PER_PAGE} total={projects.length} showSizeChanger={false} onChange={setPage} />
                            </div>
                        ) : null}
                    </>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">还没有画布</h2>
                        <p className="mt-3 text-sm text-stone-500">新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
            <Modal
                title="恢复画布"
                open={recoveryOpen}
                centered
                width={720}
                destroyOnHidden
                okText={recoveryScanning ? "正在扫描备份..." : selectedRecoveryIds.length ? `恢复 ${selectedRecoveryIds.length} 个画布` : "请选择画布"}
                cancelText="暂不恢复"
                okButtonProps={{ disabled: recoveryScanning || !selectedRecoveryIds.length, loading: recoveryApplying }}
                onOk={() => void applyRecovery()}
                onCancel={() => {
                    if (!recoveryApplying) setRecoveryOpen(false);
                }}
            >
                {recoveryScanning || !recoveryScan ? (
                    <div className="flex flex-col items-center gap-3 py-8 text-sm text-stone-600 dark:text-stone-300">
                        <Spin />
                        <p>{recoveryProgress?.total ? `正在检查本机备份（${recoveryProgress.checked} / ${recoveryProgress.total}）...` : "正在检查本机备份..."}</p>
                        <p className="text-xs text-stone-500">只读取备份，不修改任何画布数据；期间可正常使用其他功能。</p>
                    </div>
                ) : recoveryScan.projects.length ? (
                    <div className="space-y-4">
                        <p className="text-sm text-stone-600 dark:text-stone-300">已检查 {recoveryScan.sources.length} 个可读备份来源。恢复会保留当前较新的版本，并在写入前创建可回退副本。</p>
                        {recoveryScan.unreadableSources ? <Alert showIcon type="warning" message={`${recoveryScan.unreadableSources} 个备份来源无法读取，已继续检查其余来源`} /> : null}
                        <Checkbox
                            checked={selectedRecoveryIds.length === recoveryScan.projects.length}
                            indeterminate={selectedRecoveryIds.length > 0 && selectedRecoveryIds.length < recoveryScan.projects.length}
                            onChange={(event) => setSelectedRecoveryIds(event.target.checked ? recoveryScan.projects.map((project) => project.id) : [])}
                        >
                            选择全部可恢复画布
                        </Checkbox>
                        <Checkbox.Group value={selectedRecoveryIds} className="flex max-h-80 w-full flex-col gap-2 overflow-y-auto pr-1" onChange={(values) => setSelectedRecoveryIds(values.map(String))}>
                            {recoveryScan.projects.map((project) => (
                                <Checkbox key={project.id} value={project.id} className="m-0 rounded border border-stone-200 px-3 py-2 dark:border-stone-700">
                                    <span className="flex min-w-0 flex-col gap-1">
                                        <span className="truncate font-medium">{project.title}</span>
                                        <span className="text-xs text-stone-500">
                                            {project.status === "missing" ? "缺失项目" : "可恢复的新版本"} · {project.source} · {project.updatedAt ? new Date(project.updatedAt).toLocaleString() : "更新时间未知"}
                                        </span>
                                    </span>
                                </Checkbox>
                            ))}
                        </Checkbox.Group>
                        {recoveryScan.configuration ? (
                            <Checkbox checked={restoreConfiguration} onChange={(event) => setRestoreConfiguration(event.target.checked)}>
                                同时恢复 AI/WebDAV 配置（来自 {recoveryScan.configuration.source}）
                            </Checkbox>
                        ) : null}
                        <Button size="small" onClick={() => void exportRecoveryDiagnostics()}>
                            导出恢复诊断
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-3 text-sm text-stone-600 dark:text-stone-300">
                        <p>未检测到可恢复的缺失画布或较新版本。</p>
                        {recoveryScan?.unreadableSources ? <Alert showIcon type="warning" message={`${recoveryScan.unreadableSources} 个备份来源无法读取，请保留备份目录后联系支持`} /> : <p>扫描只读取本机备份，未修改任何画布或升级备份。</p>}
                        <Button size="small" onClick={() => void exportRecoveryDiagnostics()}>
                            导出恢复诊断
                        </Button>
                    </div>
                )}
            </Modal>
        </main>
    );
}
