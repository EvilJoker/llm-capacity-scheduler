/** dsh 插件（bundle）侧：地址解析、工具构造、注册与卸载。 */

import assert from "node:assert/strict";
import test from "node:test";

import { HttpBackend } from "../backend.js";
import { DEFAULT_DAEMON_URL, resolveDaemonUrl } from "../plugin/daemon.js";
import { buildLcsTools } from "../plugin/tools.js";
import { apply } from "../plugin/index.js";

test("守护进程地址：LCS_URL 优先于配置文件", () => {
  const url = resolveDaemonUrl({
    env: { LCS_URL: "http://10.0.0.9:9000/" },
    readFile: () => JSON.stringify({ engine: { web: { host: "127.0.0.1", port: 7788 } } }),
  });
  assert.equal(url, "http://10.0.0.9:9000");
});

test("守护进程地址：读 ~/.lcs/config.json，0.0.0.0 归一为回环", () => {
  const url = resolveDaemonUrl({
    env: {},
    readFile: () => JSON.stringify({ engine: { web: { host: "0.0.0.0", port: 7801 } } }),
  });
  assert.equal(url, "http://127.0.0.1:7801");
});

test("守护进程地址：读不到配置时用默认值", () => {
  const url = resolveDaemonUrl({
    env: {},
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(url, DEFAULT_DAEMON_URL);
});

test("插件构造 7 个工具，参数契约与 MCP 一致", () => {
  const tools = buildLcsTools(new HttpBackend("http://127.0.0.1:1"));
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "lcs_cancel_task",
    "lcs_get_config",
    "lcs_observe",
    "lcs_poll_tasks",
    "lcs_status",
    "lcs_submit_task",
    "lcs_tick",
  ]);
  const submit = tools.find((t) => t.name === "lcs_submit_task")!;
  const schema = JSON.stringify((submit as unknown as { parameters: unknown }).parameters);
  assert.match(schema, /prompt/);
  assert.match(schema, /value/);
  // v0.3 只有 dsh 一个执行器，插件侧不暴露 runner 参数
  assert.doesNotMatch(schema, /"runner"/);
});

test("工具调用失败时返回 error + 守护进程提示（不抛异常）", async () => {
  const backend = new HttpBackend("http://127.0.0.1:1"); // 必然连不上
  const tools = buildLcsTools(backend, { daemonUrl: "http://127.0.0.1:1" });
  const status = tools.find((t) => t.name === "lcs_status")! as unknown as {
    execute(args: Record<string, unknown>): Promise<unknown>;
  };
  const result = (await status.execute({})) as { error?: string; hint?: string };
  assert.ok(result.error, "应返回 error 字段");
  assert.match(result.hint ?? "", /守护进程/);
});

test("插件 apply：注册工具并可卸载", async () => {
  const registered: Array<{ name: string }> = [];
  const disposers: Array<() => void> = [];
  const toolsService = {
    register(definition: unknown): () => void {
      const tool = definition as { name: string };
      registered.push(tool);
      const disposer = () => {
        const index = registered.indexOf(tool);
        if (index >= 0) registered.splice(index, 1);
      };
      disposers.push(disposer);
      return disposer;
    },
  };

  let cleanup: (() => void) | null = null;
  const ctx = {
    get: (serviceName: string) => (serviceName === "tools" ? toolsService : undefined),
    effect: (effect: () => (() => void) | void) => {
      const disposer = effect();
      cleanup = typeof disposer === "function" ? disposer : null;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  apply(ctx as never);
  // 注册是异步的（动态 import），等一拍
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(registered.length, 7);
  assert.ok(cleanup);
  (cleanup as unknown as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(registered.length, 0, "卸载后不应残留工具");
});
