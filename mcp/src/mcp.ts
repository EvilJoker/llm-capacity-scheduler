/**
 * MCP Server（stdio）：给 agent 的任务接口。
 *
 * 关键语义：`提交 ≠ 执行`。`lcs_submit_task` 返回 `deferred` 是合法且预期的状态，
 * agent 应该用 `lcs_poll_tasks` 间隔取结果，而不是自己轮询等待执行。
 *
 * 后端可以是本地引擎（LocalBackend），也可以是代理到常驻守护进程（HttpBackend）——
 * 这样「agent 配一条 MCP」和「浏览器常开 Web 控制台」可以同时存在。
 *
 * 工具的参数契约来自 `tool-specs.ts`（与 dsh 插件共用一份），这里只负责翻译成 zod。
 */

import fs from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { ToolBackend } from "./backend.js";
import { TOOL_SPECS, type ToolParamSpec, type ToolSpec } from "./tool-specs.js";

/**
 * 版本号**只有一处真源**：package.json。
 *
 * 之前这里手写 "0.4.1"，发版时必须记得改两处（package.json + 这里），
 * 忘了就会「npm 包 0.4.2、--version 还是 0.4.1」。改成运行时读包内 package.json：
 * dist/mcp.js → ../package.json 就是包根（仓库里是 mcp/package.json，安装后是
 * node_modules/llm-capacity-scheduler-mcp/package.json），两边都成立。
 */
function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) return parsed.version;
  } catch {
    /* 读不到就回退，避免因为版本号读取失败让整个进程起不来 */
  }
  return "0.0.0-unknown";
}

export const VERSION = readPackageVersion();

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

/** 把参数契约翻成 zod schema（保留范围约束，MCP 侧强校验）。 */
function zodFor(param: ToolParamSpec): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (param.type) {
    case "number":
    case "integer": {
      let num = param.type === "integer" ? z.number().int() : z.number();
      if (param.min !== undefined) num = num.min(param.min);
      if (param.max !== undefined) num = num.max(param.max);
      if (param.positive) num = num.positive();
      schema = num;
      break;
    }
    case "string":
      schema = z.string();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "string[]":
      schema = z.array(z.string());
      break;
    case "number[]":
      schema = z.array(z.number());
      break;
    case "enum[]":
      schema = z.array(z.enum([...(param.enum ?? [])] as [string, ...string[]]));
      break;
    case "record":
      schema = z.record(z.string());
      break;
    default:
      schema = z.unknown();
  }
  const described = schema.describe(param.description);
  return param.required ? described : described.optional();
}

function inputShape(spec: ToolSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of spec.params) shape[param.name] = zodFor(param);
  return shape;
}

/** 供 dsh 插件复用：工具契约 + 一个调用器 → 每个工具的执行函数。 */
export interface ToolSpecHandler {
  spec: ToolSpec;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const { backend } = options;
  const server = new McpServer({
    name: options.serverName || "lcs",
    version: VERSION,
  });

  const handlers: ToolSpecHandler[] = [
    {
      spec: TOOL_SPECS[0],
      run: (input) => backend.submitTask(input as never),
    },
    {
      spec: TOOL_SPECS[1],
      run: (input) => backend.pollTasks(input as never),
    },
    {
      spec: TOOL_SPECS[2],
      run: (input) => backend.cancelTask(String(input.task_id)),
    },
    { spec: TOOL_SPECS[3], run: () => backend.status() },
    { spec: TOOL_SPECS[4], run: () => backend.observe() },
    { spec: TOOL_SPECS[5], run: () => backend.tick() },
    { spec: TOOL_SPECS[6], run: () => backend.getConfig() },
  ];

  for (const handler of handlers) {
    server.registerTool(
      handler.spec.name,
      {
        title: handler.spec.title,
        description: handler.spec.description,
        inputSchema: inputShape(handler.spec),
      },
      async (input: Record<string, unknown>) => {
        try {
          return asText(await handler.run(input));
        } catch (error) {
          return asError(error);
        }
      },
    );
  }

  return server;
}

export async function serveMcpStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
