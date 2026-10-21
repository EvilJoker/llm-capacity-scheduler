/**
 * MCP Server（stdio）：给 agent 的任务接口。
 *
 * 关键语义：`提交 ≠ 执行`。`lcs_submit_task` 返回 `deferred` 是合法且预期的状态，
 * agent 应该用 `lcs_poll_tasks` 间隔取结果，而不是自己轮询等待执行。
 *
 * 后端可以是本地引擎（LocalBackend），也可以是代理到常驻守护进程（HttpBackend）——
 * 这样「agent 配一条 MCP」和「浏览器常开 Web 控制台」可以同时存在。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { ToolBackend } from "./backend.js";

export const VERSION = "0.2.0";

export interface McpServerOptions {
  backend: ToolBackend;
  serverName?: string;
}

function asText(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function asError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        ),
      },
    ],
  };
}

const STATE_ENUM = z.enum([
  "submitted",
  "queued",
  "deferred",
  "admitted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export function createMcpServer(options: McpServerOptions): McpServer {
  const { backend } = options;
  const server = new McpServer({
    name: options.serverName || "lcs",
    version: VERSION,
  });

  server.registerTool(
    "lcs_submit_task",
    {
      title: "提交调度任务",
      description:
        "提交一个异步任务。任务不会立即执行：引擎根据 provider 容量窗口/配额策略决定何时跑（返回 state=deferred 是正常的）。" +
        "用 lcs_poll_tasks 轮询结果。幂等键相同的重复提交不会重复执行。",
      inputSchema: {
        cmd: z
          .array(z.string())
          .optional()
          .describe("shell runner 的命令数组，例如 ['python3','job.py']"),
        prompt: z.string().optional().describe("dsh headless runner 的任务文本（LLM 任务）"),
        runner: z
          .enum(["shell", "dsh"])
          .optional()
          .describe("执行器；默认用配置里的 runners.default"),
        cwd: z.string().optional().describe("执行目录（默认产物目录）"),
        env: z.record(z.string()).optional().describe("额外环境变量"),
        timeout_s: z.number().int().positive().optional().describe("单次执行超时（秒）"),
        expected_duration_s: z
          .number()
          .positive()
          .optional()
          .describe("预估执行时长（秒），用于「窗口装得下才开跑」"),
        verify_cmd: z.array(z.string()).optional().describe("验收命令：exit 0 才算成功"),
        expect_artifacts: z
          .array(z.string())
          .optional()
          .describe("声明的产物文件（相对产物目录）"),
        value: z.number().min(0).max(100).optional().describe("业务价值 0..100，越大越先跑"),
        est_pct: z.number().positive().optional().describe("预估消耗（百分点）"),
        tokens: z.number().positive().optional().describe("预估 text token 消耗"),
        est_cost: z.number().positive().optional().describe("付费型 provider 的预估成本"),
        deadline: z.string().optional().describe("截止时间，ISO 字符串；过期会被标记 expired"),
        task_class: z.string().optional().describe("任务类，用于消耗校准（同类任务共享 EWMA）"),
        idempotency_key: z.string().optional().describe("幂等键"),
        providers: z.array(z.string()).optional().describe("限定 provider（可多个）"),
        model_family: z.string().optional().describe("限定 model family，例如 general"),
        min_context: z.number().int().positive().optional().describe("最小上下文窗口"),
        modalities: z.array(z.string()).optional().describe("需要的模态，默认 text"),
        quality_tier: z.enum(["cheap", "standard", "best"]).optional(),
      },
    },
    async (input) => {
      try {
        return asText(await backend.submitTask(input));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "lcs_poll_tasks",
    {
      title: "轮询任务状态与结果",
      description:
        "批量查询任务状态、执行记录、产物与错误。传 ids 查指定任务；不传则按状态/最近任务返回。" +
        "产物在 run.artifacts 中，失败时看 error。",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("任务 id 列表"),
        states: z.array(STATE_ENUM).optional().describe("按状态过滤"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (input) => {
      try {
        return asText(await backend.pollTasks(input));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "lcs_cancel_task",
    {
      title: "取消任务",
      description: "取消一个尚未开始的任务（已在执行的 run 不会被这里取消）。",
      inputSchema: { task_id: z.string() },
    },
    async (input) => {
      try {
        return asText(await backend.cancelTask(input.task_id));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "lcs_status",
    {
      title: "调度器与容量概览",
      description:
        "返回当前容量桶（余量/窗口/reserve）、队列计数、在飞执行、最近决策原因。用于判断「为什么现在不跑」。",
      inputSchema: {},
    },
    async () => {
      try {
        return asText(await backend.status());
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "lcs_observe",
    {
      title: "立即观测容量",
      description: "主动读一次 provider 容量（会落采样，不消耗配额），返回桶与 reserve。",
      inputSchema: {},
    },
    async () => {
      try {
        return asText(await backend.observe());
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "lcs_tick",
    {
      title: "手动触发一次调度 tick",
      description: "调试/演示用：立即执行一轮 observe→reap→dispatch，返回本轮报告。",
      inputSchema: {},
    },
    async () => {
      try {
        return asText(await backend.tick());
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "lcs_get_config",
    {
      title: "读取配置（脱敏）",
      description: "读取当前配置。API Key 会以 *** 表示，不会泄露明文。",
      inputSchema: {},
    },
    async () => {
      try {
        return asText(await backend.getConfig());
      } catch (error) {
        return asError(error);
      }
    },
  );

  return server;
}

export async function serveMcpStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
