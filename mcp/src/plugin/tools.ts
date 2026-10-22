/**
 * dsh 原生工具定义（插件侧）。
 *
 * 与 MCP Server 共用 `tool-specs.ts` 的参数契约，这里翻译成 dsh-tools 的 schema DSL。
 * 插件只做转发：所有调用都打到独立常驻的 LCS 守护进程（HTTP），守护进程没跑就返回
 * 明确的错误提示，而不是把异常抛给模型。
 */

import {
  defineTool,
  type ParameterSchemaSpec,
  type ToolDefinition,
} from "@deepseek-ai/dsh-tools";

import type { ToolBackend } from "../backend.js";
import { TOOL_SPECS, type ToolParamSpec, type ToolSpec } from "../tool-specs.js";

export interface BuildToolsOptions {
  /** 守护进程地址，写进错误提示里方便排查。 */
  daemonUrl?: string;
  /** 需要排除的参数（插件侧不需要 `runner`：v0.3 只有 dsh 一个执行器）。 */
  omit?: string[];
}

/** 参数契约 → dsh-tools schema DSL。 */
export function dshParameters(spec: ToolSpec, omit: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of spec.params) {
    if (omit.has(param.name)) continue;
    const node = paramNode(param);
    if (param.required) (node as { required?: boolean }).required = true;
    out[param.name] = node;
  }
  return out;
}

function paramNode(param: ToolParamSpec): Record<string, unknown> {
  const description = param.description;
  switch (param.type) {
    case "number":
      return { type: "number", description };
    case "integer":
      return { type: "integer", description };
    case "boolean":
      return { type: "boolean", description };
    case "string[]":
      return { type: "array", items: { type: "string" }, description };
    case "number[]":
      return { type: "array", items: { type: "number" }, description };
    case "enum[]":
      return {
        type: "array",
        items: { type: "string", enum: [...(param.enum ?? [])] },
        description,
      };
    case "record":
      return { type: "object", additionalProperties: true, description };
    default:
      return { type: "string", description };
  }
}

type Runner = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * 与 dsh-tools 的 JsonValue 结构对齐的最小定义。
 * 直接从 dsh-util-values 引入会多一个运行时依赖，这里只用于类型标注。
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 7 个工具的执行函数（与 MCP 侧一一对应）。 */
export function toolRunners(backend: ToolBackend): Record<string, Runner> {
  return {
    lcs_submit_task: (input) => backend.submitTask(input as never),
    lcs_poll_tasks: (input) => backend.pollTasks(input as never),
    lcs_cancel_task: (input) => backend.cancelTask(String(input.task_id)),
    lcs_status: () => backend.status(),
    lcs_observe: () => backend.observe(),
    lcs_tick: () => backend.tick(),
    lcs_get_config: () => backend.getConfig(),
  };
}

/** 构造 dsh 原生工具定义。 */
export function buildLcsTools(backend: ToolBackend, options: BuildToolsOptions = {}): ToolDefinition[] {
  const omit = new Set(options.omit ?? ["runner"]);
  const runners = toolRunners(backend);
  const tools: ToolDefinition[] = [];

  for (const spec of TOOL_SPECS) {
    const run = runners[spec.name];
    if (!run) continue;
    const parameters = dshParameters(spec, omit);
    const tool = defineTool({
      name: spec.name,
      description: spec.description,
      parameters: parameters as unknown as ParameterSchemaSpec,
      output: {
        schema: { type: "json" },
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args: Record<string, unknown>): Promise<JsonValue> {
        try {
          return (await run(args)) as JsonValue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            error: message,
            hint: `LCS 守护进程不可达（${options.daemonUrl ?? "http://127.0.0.1:7788"}）：` +
              `请确认独立常驻服务在跑（systemctl --user status lcs 或 lcs-mcp serve）。`,
          };
        }
      },
    });
    tools.push(tool as unknown as ToolDefinition);
  }

  return tools;
}
