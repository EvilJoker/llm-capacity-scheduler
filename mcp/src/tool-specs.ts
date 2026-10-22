/**
 * LCS 工具契约（唯一真源）。
 *
 * 同一组工具有两个出口，参数语义必须完全一致，否则 agent 在 MCP 与 dsh 插件之间切换会踩坑：
 *   - MCP Server（stdio）：`src/mcp.ts` → zod schema
 *   - dsh 插件（原生工具）：`src/plugin/tools.ts` → dsh-tools schema DSL
 *
 * 因此这里只描述「参数长什么样」，由两个适配器各自翻译成目标 schema。
 * 描述文案（title/description）也在这里维护一份，模型在两个出口看到的说明一致。
 */

export type ToolParamType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "string[]"
  | "number[]"
  | "enum[]"
  | "record";

export interface ToolParamSpec {
  name: string;
  type: ToolParamType;
  required?: boolean;
  description: string;
  /** 仅 `enum[]` 使用：可选值列表。 */
  enum?: readonly string[];
  /** 数值下界（MCP 侧强校验；dsh 侧 schema DSL 无范围表达能力）。 */
  min?: number;
  /** 数值上界。 */
  max?: number;
  /** 是否要求严格大于 0。 */
  positive?: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  params: ToolParamSpec[];
}

export const TASK_STATES = [
  "submitted",
  "queued",
  "deferred",
  "admitted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "lcs_submit_task",
    title: "提交调度任务",
    description:
      "提交一个异步任务。任务不会立即执行：引擎根据 provider 容量窗口/配额策略决定何时跑（返回 state=deferred 是正常的）。" +
      "用 lcs_poll_tasks 轮询结果。幂等键相同的重复提交不会重复执行。",
    params: [
      { name: "cmd", type: "string[]", description: "任务文本/命令数组（dsh 会把它作为任务提示）" },
      { name: "prompt", type: "string", description: "dsh headless runner 的任务文本（LLM 任务）" },
      {
        name: "runner",
        type: "enum[]",
        enum: ["dsh"],
        description: "执行器；默认用配置里的 runners.default",
      },
      { name: "cwd", type: "string", description: "执行目录（默认产物目录）" },
      { name: "env", type: "record", description: "额外环境变量" },
      { name: "timeout_s", type: "integer", positive: true, description: "单次执行超时（秒）" },
      {
        name: "expected_duration_s",
        type: "number",
        positive: true,
        description: "预估执行时长（秒），用于「窗口装得下才开跑」",
      },
      { name: "verify_cmd", type: "string[]", description: "验收命令：exit 0 才算成功" },
      {
        name: "expect_artifacts",
        type: "string[]",
        description: "声明的产物文件（相对产物目录）",
      },
      { name: "value", type: "number", min: 0, max: 100, description: "业务价值 0..100，越大越先跑" },
      { name: "est_pct", type: "number", positive: true, description: "预估消耗（百分点）" },
      { name: "tokens", type: "number", positive: true, description: "预估 text token 消耗" },
      { name: "est_cost", type: "number", positive: true, description: "付费型 provider 的预估成本" },
      { name: "deadline", type: "string", description: "截止时间，ISO 字符串；过期会被标记 expired" },
      { name: "task_class", type: "string", description: "任务类，用于消耗校准（同类任务共享 EWMA）" },
      { name: "idempotency_key", type: "string", description: "幂等键" },
      { name: "providers", type: "string[]", description: "限定 provider（可多个）" },
      { name: "model_family", type: "string", description: "限定 model family，例如 general" },
      { name: "min_context", type: "integer", positive: true, description: "最小上下文窗口" },
      { name: "modalities", type: "string[]", description: "需要的模态，默认 text" },
      {
        name: "quality_tier",
        type: "enum[]",
        enum: ["cheap", "standard", "best"],
        description: "质量档位",
      },
    ],
  },
  {
    name: "lcs_poll_tasks",
    title: "轮询任务状态与结果",
    description:
      "批量查询任务状态、执行记录、产物与错误。传 ids 查指定任务；不传则按状态/最近任务返回。" +
      "产物在 run.artifacts 中，失败时看 error。",
    params: [
      { name: "ids", type: "string[]", description: "任务 id 列表" },
      {
        name: "states",
        type: "enum[]",
        enum: TASK_STATES,
        description: "按状态过滤",
      },
      { name: "limit", type: "integer", min: 1, max: 200, description: "最多返回多少条（1..200）" },
    ],
  },
  {
    name: "lcs_cancel_task",
    title: "取消任务",
    description: "取消一个尚未开始的任务（已在执行的 run 不会被这里取消）。",
    params: [{ name: "task_id", type: "string", required: true, description: "任务 id" }],
  },
  {
    name: "lcs_status",
    title: "调度器与容量概览",
    description:
      "返回当前容量桶（余量/窗口/reserve）、队列计数、在飞执行、最近决策原因。用于判断「为什么现在不跑」。",
    params: [],
  },
  {
    name: "lcs_observe",
    title: "立即观测容量",
    description: "主动读一次 provider 容量（会落采样，不消耗配额），返回桶与 reserve。",
    params: [],
  },
  {
    name: "lcs_tick",
    title: "手动触发一次调度 tick",
    description: "调试/演示用：立即执行一轮 observe→reap→dispatch，返回本轮报告。",
    params: [],
  },
  {
    name: "lcs_get_config",
    title: "读取配置（脱敏）",
    description: "读取当前配置。API Key 会以 *** 表示，不会泄露明文。",
    params: [],
  },
];

/** 按名字取工具契约。 */
export function findToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.name === name);
}
