/** Web 控制台 API：状态 / 提交 / tick / 产物 / 配置热加载与密钥脱敏。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { mergeSecrets, saveConfig, validateConfig, type Config } from "../config.js";
import { addProvider as buildProviderConfig, removeProvider as removeProviderConfig } from "../provider-presets.js";
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
    addProvider: async (input) => {
      const applied = buildProviderConfig(config, input);
      validateConfig(applied.config);
      saveConfig(applied.config, configPath);
      config = applied.config;
      engine.reload(config, dir);
      const buckets = await engine.observeNow();
      return {
        config,
        provider: applied.provider.name,
        buckets: buckets
          .filter((bucket) => bucket.provider === applied.provider.name)
          .map((bucket) => ({
            provider: bucket.provider,
            modelFamily: bucket.modelFamily,
            resourceKind: bucket.resourceKind,
            remaining: bucket.remaining,
            unit: bucket.unit,
            source: bucket.source,
            lifecycle: bucket.window.lifecycle,
          })),
      };
    },
    deleteProvider: async (name: string) => {
      const applied = removeProviderConfig(config, name);
      validateConfig(applied.config);
      saveConfig(applied.config, configPath);
      config = applied.config;
      engine.reload(config, dir);
      await engine.observeNow();
      return { config, provider: applied.provider.name };
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
    assert.equal(artifact, "burned"); // 假 dsh 写的产物

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

test("添加 LLM：厂商预设追加 provider，保存后立即可见新桶", async () => {
  const ctx = await setup();
  const realFetch = globalThis.fetch;
  // 只拦截 MiniMax 容量接口，其余（本地 Web API）走真实 fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("token_plan/remains")) {
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          model_remains: [
            {
              model_name: "general",
              start_time: ctx.clock.now() - 3600_000,
              end_time: ctx.clock.now() + 2 * 3600_000,
              current_interval_status: 1,
              current_interval_remaining_percent: 77,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input as Parameters<typeof realFetch>[0], init);
  }) as unknown as typeof fetch;

  try {
    const vendors = await ctx.api("/api/providers/vendors");
    assert.equal(vendors.data[0].id, "minimax");
    assert.equal(vendors.data[0].label, "MiniMax");
    assert.ok(vendors.data[0].models.includes(vendors.data[0].defaultModel));

    const added = await ctx.api("/api/providers", {
      method: "POST",
      body: JSON.stringify({ vendor: "minimax", apiKey: "sk-live" }),
    });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.equal(added.data.provider, "minimax");
    assert.equal(added.data.config.providers.length, 2);
    assert.equal(added.data.config.providers[1].options.apiKey, "***");
    assert.equal(added.data.config.providers[1].options.apiKeyEnv, "");
    // 预设不写模型版本：能力目录保持为空，运行时退化为 family
    assert.equal(added.data.config.models.length, 0);
    assert.equal(added.data.buckets.length, 1);
    assert.equal(added.data.buckets[0].source, "api");
    assert.equal(added.data.buckets[0].remaining, 77);
    assert.equal(added.data.buckets[0].lifecycle, "fixed_grid");

    // 容量页数据（snapshot）已经包含新桶，无需等下一次 tick
    const status = await ctx.api("/api/status");
    assert.equal(status.data.buckets.length, 2);
    assert.ok(status.data.buckets.some((b: { shortKey: string }) => b.shortKey.startsWith("minimax/")));

    // 配置文件里存的是明文 Key（0600），GET 永远脱敏
    const raw = JSON.parse(fs.readFileSync(ctx.configPath, "utf8")) as Config;
    assert.equal(raw.providers[1].options.apiKey, "sk-live");
    assert.equal((fs.statSync(ctx.configPath).mode & 0o777).toString(8), "600");
    assert.equal((await ctx.api("/api/config")).data.providers[1].options.apiKey, "***");

    // 重名自动加后缀
    const again = await ctx.api("/api/providers", {
      method: "POST",
      body: JSON.stringify({ vendor: "minimax", apiKey: "sk-2" }),
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.provider, "minimax-2");

    // 缺 Key / 未知厂商 → 400，且不落盘
    const noKey = await ctx.api("/api/providers", {
      method: "POST",
      body: JSON.stringify({ vendor: "minimax", apiKey: "  " }),
    });
    assert.equal(noKey.status, 400);
    assert.match(noKey.data.error, /API Key/);
    const badVendor = await ctx.api("/api/providers", {
      method: "POST",
      body: JSON.stringify({ vendor: "openai", apiKey: "sk-x" }),
    });
    assert.equal(badVendor.status, 400);
    assert.match(badVendor.data.error, /暂不支持/);
    const rawAfter = JSON.parse(fs.readFileSync(ctx.configPath, "utf8")) as Config;
    assert.equal(rawAfter.providers.length, 3);
  } finally {
    globalThis.fetch = realFetch;
    await ctx.web.close();
  }
});

test("删除 LLM：DELETE /api/providers/:name 移除 provider 并落盘", async () => {
  const ctx = await setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("token_plan/remains")) {
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          model_remains: [
            {
              model_name: "general",
              start_time: ctx.clock.now() - 3600_000,
              end_time: ctx.clock.now() + 2 * 3600_000,
              current_interval_status: 1,
              current_interval_remaining_percent: 77,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input as Parameters<typeof realFetch>[0], init);
  }) as unknown as typeof fetch;

  try {
    const added = await ctx.api("/api/providers", {
      method: "POST",
      body: JSON.stringify({ vendor: "minimax", apiKey: "sk-live" }),
    });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.equal(added.data.config.providers.length, 2);

    // 删除不存在的 provider → 400
    const missing = await ctx.api("/api/providers/nope", { method: "DELETE" });
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /provider 不存在/);

    const deleted = await ctx.api("/api/providers/minimax", { method: "DELETE" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    assert.equal(deleted.data.provider, "minimax");
    assert.deepEqual(
      deleted.data.config.providers.map((p: { name: string }) => p.name),
      ["mock"],
    );

    // 配置文件同步落盘
    const raw = JSON.parse(fs.readFileSync(ctx.configPath, "utf8")) as Config;
    assert.deepEqual(
      raw.providers.map((p) => p.name),
      ["mock"],
    );

    // 容量页不再有该 provider 的桶
    const status = await ctx.api("/api/status");
    assert.equal(status.data.buckets.length, 1);
    assert.ok(!status.data.buckets.some((b: { shortKey: string }) => b.shortKey.startsWith("minimax/")));
  } finally {
    globalThis.fetch = realFetch;
    await ctx.web.close();
  }
});
