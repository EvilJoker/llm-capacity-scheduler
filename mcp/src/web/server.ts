/**
 * Web 控制台后端：静态页面 + REST API。
 *
 * 默认只绑定 127.0.0.1。配置写入是敏感操作（可能含 API Key），因此 v0.2 不做远程鉴权，
 * 安全边界见 docs/MCP-DESIGN.md §11。
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactConfig, type Config } from "../config.js";
import type { Engine } from "../engine.js";
import { describeBucket, type Task } from "../types.js";
import { buildTaskFromInput } from "../task-input.js";
import { VENDOR_PRESETS, type AddProviderInput } from "../provider-presets.js";
import { log, logError } from "../util.js";

export interface AddedBucketSummary {
  provider: string;
  modelFamily: string;
  resourceKind: string;
  remaining: number | null;
  unit: string;
  source: string;
  lifecycle: string;
}

export interface AddProviderResponse {
  config: Config;
  provider: string;
  buckets: AddedBucketSummary[];
}

export interface DeleteProviderResponse {
  config: Config;
  provider: string;
}

export interface WebDeps {
  engine: Engine;
  getConfig(): Config;
  applyConfig(next: Config): Promise<Config>;
  addProvider(input: AddProviderInput): Promise<AddProviderResponse>;
  deleteProvider(name: string): Promise<DeleteProviderResponse>;
  version: string;
}

export interface RunningWebServer {
  url: string;
  port: number;
  server: http.Server;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function publicDir(): string {
  return fileURLToPath(new URL("./public/", import.meta.url));
}

async function readBody(req: http.IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error("请求体过大");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, body: string, type = "text/plain"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

export async function startWebServer(deps: WebDeps): Promise<RunningWebServer> {
  const config = deps.getConfig();
  const { engine } = deps;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, deps).catch((error) => {
      logError("web request failed", error);
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.engine.web.port, config.engine.web.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.engine.web.port;
  const host = config.engine.web.host === "0.0.0.0" ? "127.0.0.1" : config.engine.web.host;
  const url = `http://${host}:${port}`;
  log(`web console: ${url}`);

  return {
    url,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: WebDeps,
): Promise<void> {
  const { engine } = deps;
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!pathname.startsWith("/api/")) {
    return serveStatic(pathname, res);
  }

  // ---------------------------------------------------------------- health
  if (method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      version: deps.version,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      scheduler: engine.schedulerState(),
    });
  }

  // ---------------------------------------------------------------- status
  if (method === "GET" && pathname === "/api/status") {
    return sendJson(res, 200, engine.snapshot());
  }

  // ---------------------------------------------------------------- config
  if (method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, redactConfig(deps.getConfig()));
  }
  if (method === "PUT" && pathname === "/api/config") {
    const body = JSON.parse(await readBody(req)) as Config;
    const saved = await deps.applyConfig(body);
    return sendJson(res, 200, { ok: true, config: redactConfig(saved) });
  }

  // ---------------------------------------------------------------- providers
  if (method === "GET" && pathname === "/api/providers/vendors") {
    return sendJson(
      res,
      200,
      VENDOR_PRESETS.map((vendor) => ({ id: vendor.id, label: vendor.label })),
    );
  }
  if (method === "POST" && pathname === "/api/providers") {
    let body: AddProviderInput;
    try {
      body = JSON.parse(await readBody(req)) as AddProviderInput;
    } catch {
      return sendJson(res, 400, { error: "请求体不是合法 JSON" });
    }
    try {
      const result = await deps.addProvider(body);
      return sendJson(res, 200, {
        ok: true,
        provider: result.provider,
        config: redactConfig(result.config),
        buckets: result.buckets,
      });
    } catch (error) {
      // 校验类错误（缺少 Key / 不支持的厂商 / 配置冲突）回 400，前端直接展示
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(pathname);
  if (method === "DELETE" && providerMatch) {
    const name = decodeURIComponent(providerMatch[1]);
    try {
      const result = await deps.deleteProvider(name);
      return sendJson(res, 200, {
        ok: true,
        provider: result.provider,
        config: redactConfig(result.config),
      });
    } catch (error) {
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---------------------------------------------------------------- tasks
  if (method === "GET" && pathname === "/api/tasks") {
    const stateParam = url.searchParams.get("state");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const states = stateParam
      ? (stateParam.split(",").map((s) => s.trim()) as Task["state"][])
      : undefined;
    const tasks = engine.store.listTasks({
      states,
      limit: Number.isFinite(limit) ? limit : 50,
      includeTerminal: true,
    });
    return sendJson(
      res,
      200,
      tasks.map((task) => taskDetail(engine, task)),
    );
  }
  if (method === "POST" && pathname === "/api/tasks") {
    const body = JSON.parse(await readBody(req)) as Parameters<typeof buildTaskFromInput>[0];
    const task = buildTaskFromInput(body);
    const { task: saved, created } = engine.store.submit(task);
    return sendJson(res, 200, { task_id: saved.id, state: saved.state, created });
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (taskMatch && method === "GET") {
    const task = engine.store.getTask(decodeURIComponent(taskMatch[1]));
    if (!task) return sendJson(res, 404, { error: "task not found" });
    return sendJson(res, 200, taskDetail(engine, task));
  }
  const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelMatch && method === "POST") {
    const ok = engine.store.cancelTask(decodeURIComponent(cancelMatch[1]));
    return sendJson(res, 200, { cancelled: ok });
  }

  // ---------------------------------------------------------------- runs
  const artifactMatch = /^\/api\/tasks\/([^/]+)\/artifact$/.exec(pathname);
  if (artifactMatch && method === "GET") {
    const taskId = decodeURIComponent(artifactMatch[1]);
    const runId = url.searchParams.get("run") ?? "";
    const name = url.searchParams.get("name") ?? "";
    const run = engine.store.getRun(runId);
    if (!run || run.taskId !== taskId) return sendJson(res, 404, { error: "run not found" });
    const root = path.resolve(run.runDir);
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "forbidden" });
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-length": data.length,
      });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "artifact not found" });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/runs") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return sendJson(
      res,
      200,
      engine.store.recentRuns(Number.isFinite(limit) ? limit : 50).map((r) => engine.runSummary(r)),
    );
  }

  // ---------------------------------------------------------------- tick
  if (method === "POST" && pathname === "/api/tick") {
    const report = await engine.tick();
    return sendJson(res, 200, {
      tick_id: report.tickId,
      now: report.now,
      duration_ms: report.durationMs,
      spawned: report.spawned,
      reaped: report.reaped,
      interrupted: report.interrupted,
      requeued: report.requeued,
      expired: report.expired,
      decisions: report.decisions.slice(0, 40),
      errors: report.errors,
    });
  }

  // ---------------------------------------------------------------- observe
  if (method === "POST" && pathname === "/api/observe") {
    const now = engine.now();
    const buckets = await engine.observeNow(now);
    return sendJson(
      res,
      200,
      buckets.map((bucket) => describeBucket(bucket, now, engine.policy.reserveFn.reservePct(bucket, now))),
    );
  }

  if (method === "GET" && pathname === "/api/samples") {
    const limit = Number(url.searchParams.get("limit") ?? "200");
    return sendJson(
      res,
      200,
      engine.store.allSamples(Number.isFinite(limit) ? limit : 200),
    );
  }

  // ---------------------------------------------------------------- scheduler
  if (method === "POST" && pathname === "/api/scheduler/pause") {
    engine.pause();
    return sendJson(res, 200, { paused: true });
  }
  if (method === "POST" && pathname === "/api/scheduler/resume") {
    engine.resume();
    return sendJson(res, 200, { paused: false });
  }

  return sendJson(res, 404, { error: `unknown API: ${method} ${pathname}` });
}

function taskDetail(engine: Engine, task: Task): Record<string, unknown> {
  const runs = engine.store.runsForTask(task.id).map((r) => engine.runSummary(r));
  return {
    ...engine.taskSummary(task, engine.now()),
    runs,
    artifacts: [...new Set(runs.flatMap((r) => (r.artifacts as string[]) ?? []))],
  };
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const root = publicDir();
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = path.join(root, safe);
  if (!file.startsWith(root)) return sendText(res, 403, "forbidden");
  try {
    const data = fs.readFileSync(file);
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  } catch {
    sendText(res, 404, "not found");
  }
}
