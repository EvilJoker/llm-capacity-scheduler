/**
 * 会话 / 产物保留策略（GC）。
 *
 * ⚠️ 安全边界（2026-10-22 事故后收紧，务必读完再改）：
 *
 * 事故：LCS 与用户共享 `~/.dsh` 时，这里曾有一个「孤儿会话」分支——扫
 * `~/.dsh/sessions/**`，把「不属于任何 LCS task 且目录 mtime 超期」的主会话
 * 全部删掉。那删掉的是**用户自己 dsh web 的会话**，不是 LCS 的。已造成真实数据丢失。
 *
 * 现在两条硬规则：
 * 1. **只删 LCS 自己登记过的会话**（store 里 `task.checkpoint.sessionId`）。
 *    绝不按 mtime 扫目录去删「看起来没人要」的会话——LCS 没有资格判断别人的会话。
 * 2. **所有路径都限定在 `engine.dshHome`**（LCS 执行器专用 DSH_HOME）。
 *    它与用户的 `~/.dsh` 物理隔离：会话、投影缓存、profile 都在自己的家目录里。
 *    共享的只有只读文本资产（AGENTS.md / skills，见 dsh-profile.ts）。
 *
 * 另外：
 * - 绝不删非终态 task 的 session（正在跑 / 待续跑）；
 * - 支持 `dryRun`（只看会删什么，不动手），供 Web「预览清理」与 `lcs-mcp gc` 使用；
 * - 隔离家目录里出现**不属于 LCS 的会话**时只统计、不删，并在结果里报出来。
 */

import fs from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { TERMINAL_STATES } from "./types.js";

/** 单个 task 的清理明细（审计用）。 */
export interface GcDetail {
  taskId: string;
  sessionId: string | null;
  sessionRemoved: boolean;
  projectionRemoved: boolean;
  artifactsRemoved: boolean;
}

export interface GcResult {
  dryRun: boolean;
  removedSessions: number;
  removedArtifacts: number;
  removedProjections: number;
  /** 逐个 task 的明细（dryRun 时是「将会删」）。 */
  details: GcDetail[];
  /**
   * 隔离家目录里不属于任何 LCS task 的会话数。
   * 只是统计，**永远不会被删**（它们只可能来自手工调试或历史遗留）。
   */
  foreignSessions: number;
}

export interface GcOptions {
  dryRun?: boolean;
  /** 单次最多删除多少个会话（避免一次 tick 做太多 IO） */
  maxPerCall?: number;
}

/** LCS 执行器专用 DSH_HOME（会话与投影都在这里，绝不碰用户的 ~/.dsh）。 */
function dshHome(config: Config): string {
  return config.engine.dshHome;
}

function sessionsRoot(config: Config): string {
  return path.join(dshHome(config), "sessions");
}

function projCacheFile(config: Config, sessionId: string): string {
  return path.join(
    dshHome(config),
    "storages",
    "session_projcache",
    "sessions",
    `${sessionId}.json`,
  );
}

/** 在 sessions 根下找到该 session 的目录（按 sessionId 精确匹配）。 */
function findSessionDir(config: Config, sessionId: string): string | null {
  const root = sessionsRoot(config);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry, sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function removeSession(config: Config, sessionId: string, dryRun: boolean): boolean {
  const dir = findSessionDir(config, sessionId);
  if (!dir) return false;
  // 二次保险：只删 LCS 专用家目录下的东西
  const root = path.resolve(sessionsRoot(config));
  if (!path.resolve(dir).startsWith(root + path.sep)) return false;
  if (dryRun) return true; // 预览：存在就算「会删」
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function removeProjection(config: Config, sessionId: string, dryRun: boolean): boolean {
  const file = projCacheFile(config, sessionId);
  try {
    if (!fs.existsSync(file)) return false;
    if (!dryRun) fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 统计隔离家目录里「不属于任何 LCS task」的会话数（只读，不删）。 */
function countForeignSessions(config: Config, known: Set<string>): number {
  const root = sessionsRoot(config);
  let slugDirs: string[];
  try {
    slugDirs = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let foreign = 0;
  for (const slug of slugDirs) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, slug));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("session-")) continue;
      if (!known.has(name)) foreign += 1;
    }
  }
  return foreign;
}

/**
 * 清理过期会话与产物。
 *
 * 只处理**已知归属**的对象：终态 task 自己登记过的 dsh session，以及它的产物目录。
 * 未知会话（不属于任何 LCS task）一律不碰，只在 `foreignSessions` 里报个数。
 */
export function gcExpired(
  config: Config,
  store: Store,
  now: number,
  options: GcOptions = {},
): GcResult {
  const dryRun = options.dryRun === true;
  const maxPerCall = options.maxPerCall ?? 10;
  const result: GcResult = {
    dryRun,
    removedSessions: 0,
    removedArtifacts: 0,
    removedProjections: 0,
    details: [],
    foreignSessions: 0,
  };

  // 全量已知会话（含非终态）：用于统计陌生会话，也保证不会误判
  const known = new Set<string>();
  for (const task of store.listTasks({ limit: 10000, includeTerminal: true })) {
    const sessionId = task.checkpoint?.sessionId;
    if (sessionId) known.add(sessionId);
  }

  const retentionMs = Math.max(0, config.engine.sessionRetentionDays) * 24 * 3600 * 1000;
  if (retentionMs === 0) {
    // 0 = 永久保留：不删任何东西，但仍报出陌生会话数（供审计/doctor 观察）
    result.foreignSessions = countForeignSessions(config, known);
    return result;
  }

  // 终态 task 自己的会话（sessionId 来自 store，不是猜的）
  for (const task of store.listTasks({ states: TERMINAL_STATES, limit: 5000, includeTerminal: true })) {
    if (result.removedSessions >= maxPerCall) break;
    const finishedAt = task.finishedAt ?? task.updatedAt;
    if (now - finishedAt < retentionMs) continue;

    const sessionId = task.checkpoint?.sessionId ?? null;
    const detail: GcDetail = {
      taskId: task.id,
      sessionId,
      sessionRemoved: false,
      projectionRemoved: false,
      artifactsRemoved: false,
    };

    if (sessionId) {
      detail.sessionRemoved = removeSession(config, sessionId, dryRun);
      if (detail.sessionRemoved) result.removedSessions += 1;
      detail.projectionRemoved = removeProjection(config, sessionId, dryRun);
      if (detail.projectionRemoved) result.removedProjections += 1;
      if (!dryRun) {
        store.updateTask(task.id, { checkpoint: { ...task.checkpoint!, sessionId: undefined } });
      }
    }

    // 产物目录：整个 task 的产物（与 session 同保留期）
    const artifactDir = path.join(config.engine.artifactsDir, task.id);
    if (fs.existsSync(artifactDir)) {
      if (dryRun) {
        detail.artifactsRemoved = true;
        result.removedArtifacts += 1;
      } else {
        try {
          fs.rmSync(artifactDir, { recursive: true, force: true });
          detail.artifactsRemoved = true;
          result.removedArtifacts += 1;
        } catch {
          /* 删不掉就下次再试 */
        }
      }
    }

    if (detail.sessionRemoved || detail.artifactsRemoved || detail.projectionRemoved) {
      result.details.push(detail);
    }
  }

  result.foreignSessions = countForeignSessions(config, known);

  // 没有「孤儿会话」删除分支。
  // 曾经按 mtime 扫整个 sessions 根删「不属于 LCS 的会话」，那会删掉用户自己的
  // dsh 会话（2026-10-22 真实事故）。LCS 只清理自己登记过的东西。
  return result;
}
