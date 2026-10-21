/** 容量适配器：MiniMax 字段语义 + 失败降级 + mock/payg。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MinimaxAdapter, MockAdapter, PaygAdapter } from "../capacity/index.js";
import { Store } from "../store.js";
import { tmpDir } from "./helpers.js";

const NOW = new Date(2026, 9, 21, 11, 15).getTime();
const PAYLOAD = {
  model_remains: [
    {
      start_time: new Date(2026, 9, 21, 10, 0).getTime(),
      end_time: new Date(2026, 9, 21, 15, 0).getTime(),
      model_name: "general",
      current_interval_status: 1,
      current_interval_remaining_percent: 74,
      current_weekly_status: 3,
      current_weekly_remaining_percent: 100,
      weekly_start_time: new Date(2026, 9, 19).getTime(),
      weekly_end_time: new Date(2026, 9, 26).getTime(),
    },
    {
      start_time: new Date(2026, 9, 21, 0, 0).getTime(),
      end_time: new Date(2026, 9, 22, 0, 0).getTime(),
      model_name: "video",
      current_interval_status: 3,
      current_interval_remaining_percent: 100,
      current_weekly_status: 3,
      current_weekly_remaining_percent: 100,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonFetch(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("MiniMax：general 桶映射为 fixed_grid + 剩余百分比", async () => {
  const adapter = new MinimaxAdapter("minimax", { families: ["general"], apiKey: "test-key" });
  await withFetch(jsonFetch(PAYLOAD), async () => {
    const buckets = await adapter.observe(NOW);
    assert.equal(buckets.length, 1);
    const b = buckets[0];
    assert.equal(b.remaining, 74);
    assert.equal(b.window.lifecycle, "fixed_grid");
    assert.equal(b.window.endMs, new Date(2026, 9, 21, 15, 0).getTime());
    assert.equal(b.resourceKind, "text_tokens");
    assert.equal(b.source, "api");
  });
});

test("MiniMax：status=3 映射为 unlimited（不能当 100%）", async () => {
  const adapter = new MinimaxAdapter("minimax", { families: ["video"], apiKey: "test-key" });
  await withFetch(jsonFetch(PAYLOAD), async () => {
    const [b] = await adapter.observe(NOW);
    assert.equal(b.window.lifecycle, "unlimited");
    assert.equal(b.window.unlimited, true);
    assert.equal(b.remaining, null);
  });
});

test("MiniMax：weekly 桶可选，status=3 为 unlimited", async () => {
  const adapter = new MinimaxAdapter("minimax", { families: ["general"], includeWeekly: true, apiKey: "test-key" });
  await withFetch(jsonFetch(PAYLOAD), async () => {
    const buckets = await adapter.observe(NOW);
    const weekly = buckets.find((b) => b.resourceKind.endsWith("_weekly"));
    assert.ok(weekly);
    assert.equal(weekly?.window.unlimited, true);
  });
});

test("MiniMax：缺 family / 网络失败 → unknown（策略不烧）", async () => {
  const missing = new MinimaxAdapter("minimax", { families: ["image"], apiKey: "test-key" });
  await withFetch(jsonFetch(PAYLOAD), async () => {
    const [b] = await missing.observe(NOW);
    assert.equal(b.source, "unknown");
    assert.equal(b.remaining, null);
  });

  const failing = new MinimaxAdapter("minimax", { families: ["general"], apiKey: "test-key" });
  await withFetch(
    (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch,
    async () => {
      const [b] = await failing.observe(NOW);
      assert.equal(b.source, "unknown");
      assert.match(String(b.raw.error), /network down/);
    },
  );
});

test("Mock：余量随成功 run 数下降", async () => {
  const dir = tmpDir();
  const store = Store.open(path.join(dir, "state.json"));
  const adapter = new MockAdapter("mock", { start: "10:00", end: "15:00", initialRemaining: 80, burnPerRun: 6 }, { store });
  const [first] = await adapter.observe(NOW);
  assert.equal(first.remaining, 80);
  const okRun = {
    id: "r1",
    taskId: "t1",
    assignmentId: "a1",
    provider: "mock",
    model: "general",
    runner: "shell" as const,
    bucketKey: "mock/general/text_tokens/fixed_grid:-:-:-",
    est: 6,
    pid: null,
    startedAt: NOW,
    endedAt: NOW,
    status: "succeeded" as const,
    exitCode: 0,
    verified: true,
    artifacts: [],
    usage: {},
    quotaDelta: 6,
    runDir: "",
    logPath: "",
    windowEndMs: null,
  };
  // bucketKey 必须与 adapter 生成的 key 一致
  const key = (await import("../types.js")).bucketKey(first);
  store.addRun({ ...okRun, bucketKey: key });
  const [second] = await adapter.observe(NOW);
  assert.equal(second.remaining, 74);
});

test("PAYG：余额文件 → depleting money 桶；读不到 → unknown", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "payg.json");
  fs.writeFileSync(file, JSON.stringify({ balance: 12.34, currency: "USD" }));
  const adapter = new PaygAdapter("payg", { stateFile: file, unitPricePer1kTokens: 0.002 });
  const [b] = await adapter.observe(NOW);
  assert.equal(b.remaining, 12.34);
  assert.equal(b.window.lifecycle, "depleting");
  assert.equal(b.unit, "money");
  assert.equal(b.raw.unitPricePer1kTokens, 0.002);

  const broken = new PaygAdapter("payg", { stateFile: path.join(dir, "missing.json") });
  const [missing] = await broken.observe(NOW);
  assert.equal(missing.source, "unknown");
});
