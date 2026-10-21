/** Web 控制台 API：状态 / 提交 / tick / 产物 / 配置热加载与密钥脱敏。 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { mergeSecrets, saveConfig, validateConfig, type Config } from "../config.js";
import { buildEngine, FakeClock, makeConfig, tmpDir, waitForTask } from "./helpers.js";
import { startWebServer } from "../web/server.js";

const NODE = process.execPath;
const WED_14_35 = new Date(2026, 9, 21, 14, 35).getTime();

async function setup() {
  const dir = tmpDir();
  const configPath = path.join(dir, "lcs.config.json");
  let config = makeConfig({ dir, policy: { windowGraceSeconds: 1, maxConcurrentPerBucket: 2 } });
  config.providers[0].options.apiKey = "sk-secret";
  config.engine.web.port = 0;
  saveConfig(config, configPath);

  const clock = new FakeClock(WED_14_35);
  const engine = buildEngine(config, clock, dir);
  const web = await startWebServer({
    engine,
    getConfig: () => config,
    applyConfig: async (incoming: Config) => {
      const next = mergeSecrets(incoming, config);
      validateConfig(next);
      saveConfig(next, configPath);
      config = next;
      engine.reload(next, dir);
      return next;
    },
    version: "test",
  });
  const base = web.url;
  const api = async (pathname: string, init?: RequestInit) => {
    const resp = await fetch(base + pathname, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    const text = await resp.text();
    return { status: resp.status, data: text ? JSON.parse(text) : null, text };
  };
  return { dir, configPath, clock, engine, web, base, api, apiRaw: async (p: string) => (await fetch(base + p)).text() };
}

test("健康检查 + 静态页面", async () => {
  const ctx = await setup();
  try {
    const health = await ctx.api("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    const html = await ctx.apiRaw("/");
    assert.match(html, /容量调度控制台/);
  } finally {
    await ctx.web.close();
  }
});

test("提交任务 → tick → 轮询 → 产物下载", async () => {
  const ctx = await setup();
  try {
    const submit = await ctx.api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        cmd: [NODE, "-e", "require('fs').writeFileSync('out.txt','web-burn')"],
        value: 42,
        expect_artifacts: ["out.txt"],
      }),
    });
    assert.equal(submit.status, 200);
    const taskId = submit.data.task_id as string;

    const tick = await ctx.api("/api/tick", { method: "POST" });
    assert.equal(tick.status, 200);
    assert.equal(tick.data.spawned.length, 1);

    const state = await waitForTask(ctx.engine, ctx.clock, taskId);
    assert.equal(state, "succeeded");
    const tasks = await ctx.api(`/api/tasks/${taskId}`);
    assert.equal(tasks.data.state, "succeeded");
    assert.ok(tasks.data.artifacts.includes("out.txt"));

    const run = tasks.data.runs[0];
    const artifact = await ctx.apiRaw(
      `/api/tasks/${taskId}/artifact?run=${encodeURIComponent(run.id)}&name=out.txt`,
    );
    assert.equal(artifact, "web-burn");

    const status = await ctx.api("/api/status");
    assert.equal(status.data.taskCounts.succeeded, 1);
    assert.equal(status.data.buckets.length, 1);
  } finally {
    await ctx.web.close();
  }
});

test("配置：GET 脱敏，PUT 保留旧密钥并热加载", async () => {
  const ctx = await setup();
  try {
    const got = await ctx.api("/api/config");
    assert.equal(got.data.providers[0].options.apiKey, "***");

    const next = got.data as Config;
    next.policy.minReservePct = 7;
    next.providers[0].options.apiKey = "***"; // 表示保留
    const saved = await ctx.api("/api/config", { method: "PUT", body: JSON.stringify(next) });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.config.policy.minReservePct, 7);

    const enginePolicy = ctx.engine.policy.policy.minReservePct;
    assert.equal(enginePolicy, 7);

    const raw = JSON.parse(
      (await import("node:fs")).readFileSync(ctx.configPath, "utf8"),
    ) as Config;
    assert.equal(raw.providers[0].options.apiKey, "sk-secret");
  } finally {
    await ctx.web.close();
  }
});

test("调度器暂停/恢复", async () => {
  const ctx = await setup();
  try {
    await ctx.api("/api/scheduler/pause", { method: "POST" });
    const paused = await ctx.api("/api/status");
    assert.equal(paused.data.scheduler.paused, true);
    await ctx.api("/api/scheduler/resume", { method: "POST" });
    const resumed = await ctx.api("/api/status");
    assert.equal(resumed.data.scheduler.paused, false);
  } finally {
    await ctx.web.close();
  }
});
