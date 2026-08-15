function createPersistenceFlushCoordinator({ timeoutMs = 15000, onTimeout = () => undefined } = {}) {
    let sequence = 0;
    let pending = null;

    function begin(action, details = {}) {
        if (pending) {
            if (pending.action === action) return { request: { id: pending.id, action }, promise: pending.promise, reused: true };
            throw new Error("另一项退出操作正在进行，请稍后重试");
        }
        const id = `${Date.now()}-${++sequence}`;
        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        const timer = setTimeout(() => {
            if (!pending || pending.id !== id) return;
            const expired = pending;
            pending = null;
            const error = new Error("等待本地数据保存超时，安装未启动；请稍后重试");
            onTimeout(expired, error);
            expired.reject(error);
        }, timeoutMs);
        pending = { id, action, details, promise, resolve: resolvePromise, reject: rejectPromise, timer };
        return { request: { id, action }, promise, reused: false };
    }

    function acknowledge(id) {
        if (!pending || pending.id !== id) return null;
        const acknowledged = pending;
        pending = null;
        clearTimeout(acknowledged.timer);
        return acknowledged;
    }

    function succeed(request, value) {
        request.resolve(value);
    }

    function fail(request, error) {
        request.reject(error instanceof Error ? error : new Error(String(error || "操作失败")));
    }

    function current() {
        return pending ? { id: pending.id, action: pending.action } : null;
    }

    return { acknowledge, begin, current, fail, succeed };
}

function buildInstallerArgs(installDir) {
    return [`/D=${installDir}`];
}

function buildInstallerLaunchOptions() {
    return { detached: true, stdio: "ignore" };
}

module.exports = { buildInstallerArgs, buildInstallerLaunchOptions, createPersistenceFlushCoordinator };
