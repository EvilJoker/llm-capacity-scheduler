/**
 * LCS 的 dsh 插件入口（bundle）。
 *
 * 定位：**纯客户端**。
 *   - LCS 调度器是独立常驻进程（`lcs-mcp serve`，7×24），负责调度、计量、Web 控制台；
 *   - dsh 只是**执行器**：守护进程用 `dsh --profile lcs` 起子进程跑任务；
 *   - 本插件把 7 个 `lcs_*` 工具注册进 dsh 的工具集，调用时转发给守护进程的 HTTP API。
 *
 * 因此插件**不抢单实例锁、不监听端口、不起调度器**：
 * 守护进程没跑时，工具返回明确错误，而不是抛异常给模型。
 *
 * 装载方式：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 里的 insert 行。
 */

import { HttpBackend } from "../backend.js";
import { resolveDaemonUrl } from "./daemon.js";

export const name = "lcs";

/** dsh 插件名（bundle 内会出现在插件清单里）。 */
export const pluginName = "lcs";

interface ToolsService {
  register(definition: unknown): () => void;
}

interface PluginContext {
  get(name: string): unknown;
  effect(effect: () => (() => void) | void): void;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}

function log(ctx: PluginContext, level: "info" | "warn" | "error", message: string): void {
  // 始终写 stderr：dsh 的 stdout 是事件流/协议通道，日志只能走 stderr；
  // 同时尽力交给宿主 logger（失败不影响插件）。
  process.stderr.write(`[lcs] ${message}\n`);
  const logger = ctx.logger;
  if (logger) {
    const fn = logger[level];
    // 必须以 logger 为 this 调用：cordis 的 LoggerService.info/warn/error 依赖 this
    // 拿到 fiber 上下文，解绑后调用会抛 "this is not a function"（实测：直接让 profile 起不来）。
    if (typeof fn === "function") {
      try {
        fn.call(logger, message);
      } catch {
        /* 宿主 logger 不可用时忽略 */
      }
    }
  }
}

/**
 * 等待 `tools` 服务就绪。
 *
 * patch/bundle 层与拥有 tools 服务的 bundle 在同一批事务里激活，apply 时
 * `ctx.get('tools')` 可能还拿不到——这里轮询等待，和 dsh-mmx-bridge 的做法一致。
 */
function waitForService(
  ctx: PluginContext,
  serviceName: string,
  timeoutMs: number,
  onReady: (service: ToolsService) => void,
): () => void {
  const started = Date.now();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const probe = (): void => {
    if (stopped) return;
    let service: unknown;
    try {
      service = ctx.get(serviceName);
    } catch {
      service = undefined;
    }
    if (service !== undefined) {
      stopped = true;
      stop();
      onReady(service as ToolsService);
      return;
    }
    if (Date.now() - started >= timeoutMs) {
      stopped = true;
      stop();
      log(ctx, "warn", `等待 ${serviceName} 服务超时（${timeoutMs}ms），lcs 工具未注册`);
    }
  };

  timer = setInterval(probe, 250);
  probe();
  return stop;
}

export function apply(ctx: PluginContext): void {
  const daemonUrl = resolveDaemonUrl();
  const backend = new HttpBackend(daemonUrl);

  ctx.effect(() => {
    let stopWait: () => void = () => {};
    let dispose: (() => void) | null = null;

    const register = (tools: ToolsService): void => {
      // 动态 import：dsh-tools 是宿主提供的包（peerDependency）。万一宿主里解析不到，
      // 也只是「工具没注册」，而不是整个 bundle 挂掉、连累整个 profile 起不来。
      void import("./tools.js")
        .then(({ buildLcsTools }) => {
          const definitions = buildLcsTools(backend, { daemonUrl });
          const disposers = definitions.map((definition) => tools.register(definition));
          dispose = () => {
            for (const d of disposers) {
              try {
                d();
              } catch {
                /* 忽略卸载错误 */
              }
            }
          };
          log(
            ctx,
            "info",
            `lcs 插件已加载：${definitions.length} 个工具已注册 → 守护进程 ${daemonUrl}`,
          );
          return probeDaemon(daemonUrl).then((ok) => {
            log(
              ctx,
              ok ? "info" : "warn",
              ok
                ? `lcs 守护进程可达：${daemonUrl}`
                : `lcs 守护进程暂时不可达（${daemonUrl}）：请启动 systemctl --user start lcs`,
            );
          });
        })
        .catch((error) => {
          log(ctx, "error", `lcs 工具注册失败：${String(error)}`);
        });
    };

    stopWait = waitForService(ctx, "tools", 60_000, register);

    return () => {
      stopWait();
      if (dispose !== null) dispose();
    };
  });
}

/** 探测守护进程是否在跑（只读 health，不改状态）。 */
export async function probeDaemon(daemonUrl: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${daemonUrl}/api/health`, { signal: controller.signal });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok !== false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default { name, apply };
