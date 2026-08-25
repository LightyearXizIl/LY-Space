export type CanvasGenerationRequest = {
    /** 请求实例标识；请求表按该字段存储，不能用结果节点 ID 覆盖并发请求。 */
    requestId: string;
    /** 用户每次点击生成创建一个 run；同一批次的槽位共享该值。 */
    runId: string;
    targetNodeId: string;
    originNodeId: string;
    /** 面板停止按钮归属的发起节点。 */
    runningNodeId: string;
    controller: AbortController;
};

export type CanvasGenerationCancellation = {
    targetNodeIds: Set<string>;
    originNodeIds: Set<string>;
    runningNodeId: string;
    hasRemainingForRun: boolean;
};

let requestSequence = 0;
let runSequence = 0;

function nextRequestId() {
    requestSequence += 1;
    return `canvas-request-${requestSequence}`;
}

export function createCanvasGenerationRunId() {
    runSequence += 1;
    return `canvas-run-${runSequence}`;
}

export function startCanvasGenerationRequest(
    requests: Map<string, CanvasGenerationRequest>,
    targetNodeId: string,
    originNodeId: string,
    runningNodeId = originNodeId,
    controller = new AbortController(),
    runId = createCanvasGenerationRunId(),
) {
    const request: CanvasGenerationRequest = { requestId: nextRequestId(), runId, targetNodeId, originNodeId, runningNodeId, controller };
    requests.set(request.requestId, request);
    return request;
}

/** 只有仍由同一请求句柄持有时才允许写回或结束。 */
export function isCanvasGenerationRequestActive(requests: Map<string, CanvasGenerationRequest>, request: CanvasGenerationRequest) {
    return requests.get(request.requestId)?.controller === request.controller && !request.controller.signal.aborted;
}

export function finishCanvasGenerationRequest(requests: Map<string, CanvasGenerationRequest>, request: CanvasGenerationRequest) {
    if (requests.get(request.requestId)?.controller === request.controller) requests.delete(request.requestId);
}

/** 仅取消指定结果节点；同一控制器的别名也会一并清理。 */
export function cancelCanvasGenerationTarget(requests: Map<string, CanvasGenerationRequest>, targetNodeId: string): CanvasGenerationCancellation | null {
    const request = Array.from(requests.values()).find((candidate) => candidate.targetNodeId === targetNodeId);
    if (!request) return null;
    const targetNodeIds = new Set<string>();
    const originNodeIds = new Set<string>();
    request.controller.abort();
    Array.from(requests.entries()).forEach(([id, candidate]) => {
        if (candidate.controller !== request.controller) return;
        requests.delete(id);
        targetNodeIds.add(candidate.targetNodeId);
        originNodeIds.add(candidate.originNodeId);
    });
    return { targetNodeIds, originNodeIds, runningNodeId: request.runningNodeId, hasRemainingForRun: hasCanvasGenerationRun(requests, request.runningNodeId) };
}

/** 停止某个发起节点的全部未完成请求。 */
export function cancelCanvasGenerationRun(requests: Map<string, CanvasGenerationRequest>, runningNodeId: string): CanvasGenerationCancellation | null {
    const targetNodeIds = new Set<string>();
    const originNodeIds = new Set<string>();
    const controllers = new Set<AbortController>();
    Array.from(requests.entries()).forEach(([id, request]) => {
        if (request.runningNodeId !== runningNodeId) return;
        requests.delete(id);
        controllers.add(request.controller);
        targetNodeIds.add(request.targetNodeId);
        originNodeIds.add(request.originNodeId);
    });
    if (!controllers.size) return null;
    controllers.forEach((controller) => controller.abort());
    return { targetNodeIds, originNodeIds, runningNodeId, hasRemainingForRun: false };
}

export function hasCanvasGenerationRequest(requests: Map<string, CanvasGenerationRequest>, targetNodeId: string) {
    return Array.from(requests.values()).some((request) => request.targetNodeId === targetNodeId);
}

export function hasCanvasGenerationRun(requests: Map<string, CanvasGenerationRequest>, runningNodeId: string) {
    return Array.from(requests.values()).some((request) => request.runningNodeId === runningNodeId);
}

export function getActiveCanvasGenerationNodeIds(requests: Map<string, CanvasGenerationRequest>) {
    return new Set(Array.from(requests.values()).map((request) => request.runningNodeId));
}
