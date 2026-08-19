export type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

export type CanvasGenerationCancellation = {
    targetNodeIds: Set<string>;
    originNodeIds: Set<string>;
    runningNodeId: string;
    hasRemainingForRun: boolean;
};

export function startCanvasGenerationRequest(requests: Map<string, CanvasGenerationRequest>, targetNodeId: string, originNodeId: string, runningNodeId = originNodeId, controller = new AbortController()) {
    const previous = requests.get(targetNodeId);
    if (previous?.controller !== controller) previous?.controller.abort();
    requests.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId, controller });
    return controller;
}

export function finishCanvasGenerationRequest(requests: Map<string, CanvasGenerationRequest>, targetNodeId: string, controller: AbortController) {
    if (requests.get(targetNodeId)?.controller === controller) requests.delete(targetNodeId);
}

/** 仅取消指定结果节点；同一控制器的别名也会一并清理。 */
export function cancelCanvasGenerationTarget(requests: Map<string, CanvasGenerationRequest>, targetNodeId: string): CanvasGenerationCancellation | null {
    const request = requests.get(targetNodeId);
    if (!request) return null;
    const targetNodeIds = new Set<string>();
    const originNodeIds = new Set<string>();
    request.controller.abort();
    requests.forEach((candidate, id) => {
        if (candidate.controller !== request.controller) return;
        requests.delete(id);
        targetNodeIds.add(candidate.targetNodeId);
        originNodeIds.add(candidate.originNodeId);
    });
    return { targetNodeIds, originNodeIds, runningNodeId: request.runningNodeId, hasRemainingForRun: hasRunningRequest(requests, request.runningNodeId) };
}

/** 停止某个发起节点的全部未完成请求。 */
export function cancelCanvasGenerationRun(requests: Map<string, CanvasGenerationRequest>, runningNodeId: string): CanvasGenerationCancellation | null {
    const targetNodeIds = new Set<string>();
    const originNodeIds = new Set<string>();
    const controllers = new Set<AbortController>();
    requests.forEach((request, id) => {
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
    return requests.has(targetNodeId);
}

function hasRunningRequest(requests: Map<string, CanvasGenerationRequest>, runningNodeId: string) {
    return Array.from(requests.values()).some((request) => request.runningNodeId === runningNodeId);
}
