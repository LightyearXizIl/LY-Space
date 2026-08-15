const assert = require("node:assert/strict");
const test = require("node:test");

const { buildInstallerArgs, createPersistenceFlushCoordinator } = require("../update-install-coordinator.cjs");

test("静默更新参数要求安装后重启，且 /D= 保持最后", () => {
    const args = buildInstallerArgs("D:\\Software\\LY Space");
    assert.deepEqual(args, ["/S", "--force-run", "/D=D:\\Software\\LY Space"]);
    assert.match(args.at(-1), /^\/D=/);
});

test("持久化回执必须匹配当前请求且成功后不会重复执行", async () => {
    const coordinator = createPersistenceFlushCoordinator({ timeoutMs: 1000 });
    const started = coordinator.begin("install", { installerPath: "setup.exe" });
    assert.equal(coordinator.acknowledge("stale-request"), null);
    const acknowledged = coordinator.acknowledge(started.request.id);
    assert.equal(acknowledged.details.installerPath, "setup.exe");
    assert.equal(coordinator.acknowledge(started.request.id), null);
    coordinator.succeed(acknowledged, "spawned");
    assert.equal(await started.promise, "spawned");
});

test("保存超时会撤销安装请求且迟到回执被忽略", async () => {
    let timeoutRequest = null;
    const coordinator = createPersistenceFlushCoordinator({ timeoutMs: 20, onTimeout: (request) => { timeoutRequest = request; } });
    const started = coordinator.begin("install");
    await assert.rejects(started.promise, /保存超时/);
    assert.equal(timeoutRequest.id, started.request.id);
    assert.equal(coordinator.current(), null);
    assert.equal(coordinator.acknowledge(started.request.id), null);

    const retried = coordinator.begin("install");
    const acknowledged = coordinator.acknowledge(retried.request.id);
    coordinator.succeed(acknowledged);
    await retried.promise;
});

test("重复点击复用同一请求且不会与关闭请求混用", async () => {
    const coordinator = createPersistenceFlushCoordinator({ timeoutMs: 1000 });
    const first = coordinator.begin("install");
    const second = coordinator.begin("install");
    assert.equal(second.reused, true);
    assert.equal(second.promise, first.promise);
    assert.throws(() => coordinator.begin("quit"), /另一项退出操作/);
    const acknowledged = coordinator.acknowledge(first.request.id);
    coordinator.succeed(acknowledged);
    await first.promise;
});
