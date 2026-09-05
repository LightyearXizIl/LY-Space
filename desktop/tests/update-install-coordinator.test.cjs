const assert = require("node:assert/strict");
const test = require("node:test");

const { INSTALLER_QUIT_FLAG, isInstallerQuitRequest, buildInstallerArgs, buildInstallerLaunchOptions, createPersistenceFlushCoordinator } = require("../update-install-coordinator.cjs");

test("安装退出通知只匹配当前安装路径，不接受同名其他目录或普通启动", () => {
    const executable = "D:\\Apps\\LY Space\\LY Space.exe";
    assert.equal(isInstallerQuitRequest([INSTALLER_QUIT_FLAG, "--lyspace-install-dir=D:\\Apps\\LY Space"], executable), true);
    assert.equal(isInstallerQuitRequest([INSTALLER_QUIT_FLAG, "--lyspace-install-dir=d:\\apps\\ly space\\"], executable), true);
    assert.equal(isInstallerQuitRequest([INSTALLER_QUIT_FLAG, "--lyspace-install-dir=D:\\Apps\\LY Space Other"], executable), false);
    assert.equal(isInstallerQuitRequest([INSTALLER_QUIT_FLAG, "--lyspace-install-dir=LY Space"], executable), false);
    assert.equal(isInstallerQuitRequest(["--lyspace-install-dir=D:\\Apps\\LY Space"], executable), false);
});

test("保存失败回执可阻止退出并允许重试", async () => {
    const coordinator = createPersistenceFlushCoordinator();
    const started = coordinator.begin("quit");
    const failed = coordinator.acknowledge(started.request.id);
    coordinator.fail(failed, new Error("本地数据保存失败"));
    await assert.rejects(started.promise, /保存失败/);
    assert.equal(coordinator.current(), null);
    const retry = coordinator.begin("quit");
    coordinator.succeed(coordinator.acknowledge(retry.request.id));
    await retry.promise;
});

test("可见更新安装器仅预填当前安装目录，且 /D= 保持最后", () => {
    const args = buildInstallerArgs("D:\\Software\\LY Space");
    assert.deepEqual(args, ["/D=D:\\Software\\LY Space"]);
    assert.match(args.at(-1), /^\/D=/);
    assert.equal(args.includes("/S"), false);
    assert.equal(args.includes("--force-run"), false);
});

test("可见更新安装器不隐藏窗口", () => {
    const options = buildInstallerLaunchOptions();
    assert.deepEqual(options, { detached: true, stdio: "ignore" });
    assert.equal(Object.hasOwn(options, "windowsHide"), false);
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
