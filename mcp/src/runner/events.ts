/**
 * dsh headless 事件流解析：把 NDJSON（stdout）压成调度器需要的几个事实。
 *
 * 契约（实测）：session → status(turn_start/step_start/step_end/turn_end) → text/thinking → final。
 * 解析必须宽松：未知事件忽略、非 JSON 行忽略（stderr 混进来也不怕）。
 */

export interface DshUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface DshEventSummary {
  sessionId?: string;
  /** 最终答案（final 事件） */
  finalText?: string;
  /** 最近一次 step_end 的用量 */
  usage?: DshUsage;
  /** turn_end 的错误 */
  error?: { code?: string; message?: string };
  /** turn_end 的原因（completed / error / aborted …） */
  turnReason?: string;
  /** 是否收到 final 事件 */
  hasFinal: boolean;
}

export function parseDshEvents(raw: string): DshEventSummary {
  const summary: DshEventSummary = { hasFinal: false };
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text || !text.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    switch (type) {
      case "session": {
        if (typeof event.sessionId === "string") summary.sessionId = event.sessionId;
        break;
      }
      case "final": {
        summary.hasFinal = true;
        if (typeof event.text === "string") summary.finalText = event.text;
        break;
      }
      case "status": {
        const phase = typeof event.phase === "string" ? event.phase : "";
        if (phase === "step_end") {
          const usage = event.usage as DshUsage | undefined;
          if (usage && typeof usage === "object") summary.usage = usage;
        }
        if (phase === "turn_end") {
          const reason = event.reason as { kind?: string; error?: { code?: string; message?: string } } | undefined;
          if (reason) {
            summary.turnReason = reason.kind;
            if (reason.error) {
              summary.error = { code: reason.error.code, message: reason.error.message };
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return summary;
}
