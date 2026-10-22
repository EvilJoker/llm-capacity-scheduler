/**
 * 会话 / 产物保留策略（GC）。
 *
 * 背景：LCS 与用户共享 `~/.dsh`，调度产生的 dsh session 会堆在
 * `~/.dsh/sessions/<cwd-slug>/session-<id>/`，同时让 `session.list` 变大。
 * 策略：
 * - task 终态且超过保留期 → 删它的 dsh session 目录 + 投影缓存 + 产物目录；
 * - 不在 tasks 里的孤儿 session（按 mtime 判断年龄）→ 超过保留期也删；
 * - **绝不删非终态 task 的 session**（正在跑/待续跑）。
 *
 * 定位 session 目录不复刻 dsh 的 slug 规则，直接按 sessionId 在 sessions 根下找。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { TERMINAL_STATES } from "./types.js";

export interface GcResult {
  removedSessions: number;
  removedArtifacts: number;
  removedProjections: number;
}

function dshHome(): string {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
}

function sessionsRoot(): string {
  return path.join(dshHome(), "sessions");
}

function projCacheFile(sessionId: string): string {
  return path.join(
    dshHome(),
    "storages",
    "session_projcache",
    "sessions",
    `${sessionId}.json`,
  );
}

/** 在 sessions 根下找到该 session 的目录（按 sessionId 精确匹配）。 */
function findSessionDir(sessionId: string): string | null {
  const root = sessionsRoot();
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

function removeSession(sessionId: string): boolean {
  const dir = findSessionDir(sessionId);
  if (!dir) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function removeProjection(sessionId: string): boolean {
  const file = projCacheFile(sessionId);
  try {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理过期会话与产物。
 * @param maxPerCall 单次最多删除多少个会话（避免一次 tick 做太多 IO）
 */
export function gcExpired(
  config: Config,
  store: Store,
  now: number,
  maxPerCall = 10,
): GcResult {
  const result: GcResult = { removedSessions: 0, removedArtifacts: 0, removedProjections: 0 };
  const retentionMs = Math.max(0, config.engine.sessionRetentionDays) * 24 * 3600 * 1000;
  if (retentionMs === 0) return result; // 0 = 永久保留

  // 1) 终态 task 的会话
  for (const task of store.listTasks({ states: TERMINAL_STATES, limit: 5000, includeTerminal: true })) {
    if (result.removedSessions >= maxPerCall) break;
    const finishedAt = task.finishedAt ?? task.updatedAt;
    if (now - finishedAt < retentionMs) continue;
    const sessionId = task.checkpoint?.sessionId;
    if (sessionId) {
      if (removeSession(sessionId)) result.removedSessions += 1;
      if (removeProjection(sessionId)) result.removedProjections += 1;
      store.updateTask(task.id, { checkpoint: { ...task.checkpoint!, sessionId: undefined } });
    }
    // 产物目录：整个 task 的产物（与 session 同保留期）
    const artifactDir = path.join(config.engine.artifactsDir, task.id);
    if (fs.existsSync(artifactDir)) {
      try {
        fs.rmSync(artifactDir, { recursive: true, force: true });
        result.removedArtifacts += 1;
      } catch {
        /* 删不掉就下次再试 */
      }
    }
  }

  // 2) 孤儿会话（不属于任何 task），按目录 mtime 判断年龄
  const known = new Set<string>();
  for (const task of store.listTasks({ limit: 10000, includeTerminal: true })) {
    const sessionId = task.checkpoint?.sessionId;
    if (sessionId) known.add(sessionId);
  }
  const root = sessionsRoot();
  let slugDirs: string[] = [];
  try {
    slugDirs = fs.readdirSync(root);
  } catch {
    slugDirs = [];
  }
  for (const slug of slugDirs) {
    if (result.removedSessions >= maxPerCall) break;
    const slugDir = path.join(root, slug);
    let names: string[];
    try {
      names = fs.readdirSync(slugDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (result.removedSessions >= maxPerCall) break;
      if (!name.startsWith("session-")) continue;
      if (known.has(name)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(slugDir, name)).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs < retentionMs) continue;
      try {
        fs.rmSync(path.join(slugDir, name), { recursive: true, force: true });
        result.removedSessions += 1;
        if (removeProjection(name)) result.removedProjections += 1;
      } catch {
        /* 忽略 */
      }
    }
  }

  return result;
}
