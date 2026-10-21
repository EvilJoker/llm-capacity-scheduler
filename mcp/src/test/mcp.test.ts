/** MCP 工具面：listTools + submit → tick → poll 闭环（InMemory transport）。 */

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { LocalBackend } from "../backend.js";
import { createMcpServer } from "../mcp.js";
import { buildEngine, FakeClock, makeConfig, sleep, tmpDir } from "./helpers.js";

const NODE = process.execPath;
const WED_14_35 = new Date(2026, 9, 21, 14, 35).getTime();

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

test("MCP：submit → tick → poll 拿到产物", async () => {
  const dir = tmpDir();
  const config = makeConfig({ dir, policy: { windowGraceSeconds: 1 } });
  const clock = new FakeClock(WED_14_35);
  const engine = buildEngine(config, clock, dir);
  const server = createMcpServer({ backend: new LocalBackend(engine, () => config), serverName: "lcs" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "lcs_cancel_task",
      "lcs_get_config",
      "lcs_observe",
      "lcs_poll_tasks",
      "lcs_status",
      "lcs_submit_task",
      "lcs_tick",
    ]);

    const submit = await client.callTool({
      name: "lcs_submit_task",
      arguments: {
        cmd: [NODE, "-e", "require('fs').writeFileSync('out.txt','mcp-burn')"],
        value: 66,
        expect_artifacts: ["out.txt"],
        idempotency_key: "mcp-test-1",
      },
    });
    const submitted = JSON.parse(textOf(submit)) as { task_id: string; state: string };
    assert.ok(submitted.task_id);
    assert.equal(submitted.state, "submitted");

    // 幂等：重复提交返回同一任务
    const again = await client.callTool({
      name: "lcs_submit_task",
      arguments: { cmd: [NODE, "-e", "1"], idempotency_key: "mcp-test-1" },
    });
    const againPayload = JSON.parse(textOf(again)) as { task_id: string; created: boolean };
    assert.equal(againPayload.created, false);
    assert.equal(againPayload.task_id, submitted.task_id);

    const tick = JSON.parse(textOf(await client.callTool({ name: "lcs_tick", arguments: {} }))) as {
      spawned: unknown[];
    };
    assert.equal(tick.spawned.length, 1);

    for (let i = 0; i < 100; i += 1) {
      if (engine.store.getTask(submitted.task_id)!.state === "succeeded") break;
      await client.callTool({ name: "lcs_tick", arguments: {} });
      clock.advance(5000);
      await sleep(20);
    }
    assert.equal(engine.store.getTask(submitted.task_id)!.state, "succeeded");

    const poll = JSON.parse(
      textOf(await client.callTool({ name: "lcs_poll_tasks", arguments: { ids: [submitted.task_id] } })),
    ) as Array<{ state: string; runs: Array<{ artifacts: string[]; verified: boolean }> }>;
    assert.equal(poll[0].state, "succeeded");
    assert.equal(poll[0].runs[0].verified, true);
    assert.ok(poll[0].runs[0].artifacts.includes("out.txt"));

    const status = JSON.parse(textOf(await client.callTool({ name: "lcs_status", arguments: {} }))) as {
      buckets: unknown[];
      taskCounts: Record<string, number>;
    };
    assert.equal(status.buckets.length, 1);
    assert.equal(status.taskCounts.succeeded, 1);

    const configView = JSON.parse(textOf(await client.callTool({ name: "lcs_get_config", arguments: {} }))) as {
      providers: Array<{ options: { apiKey?: string } }>;
    };
    assert.equal(configView.providers[0].options.apiKey, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});
