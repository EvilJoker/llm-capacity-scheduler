/** 通用工具：时间、原子写、ID、日志、深合并。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function nowMs(): number {
  return Date.now();
}

export function clamp(value: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, value));
}

export function uid(prefix: string): string {
  const rnd = Math.random().toString(16).slice(2, 10);
  const t = Date.now().toString(36);
  return `${prefix}_${t}${rnd}`;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolvePath(p: string, baseDir: string): string {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** tmp + rename 原子写，避免半截 JSON。 */
export function atomicWriteFileSync(file: string, content: string, mode = 0o600): void {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** "09:00" → 540（分钟） */
export function parseHHMM(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`非法时间格式: ${text}（应为 HH:MM）`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`非法时间: ${text}`);
  return hh * 60 + mm;
}

/** ISO weekday：1=Mon … 7=Sun */
export function isoWeekday(ms: number): number {
  const day = new Date(ms).getDay();
  return day === 0 ? 7 : day;
}

export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export function startOfNextDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function atMinutes(ms: number, minutes: number): number {
  const d = new Date(ms);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (Array.isArray(base)) return (Array.isArray(patch) ? patch : base) as T;
  if (base !== null && typeof base === "object") {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return base;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      out[key] =
        key in out ? deepMerge((out as Record<string, unknown>)[key], value) : value;
    }
    return out as T;
  }
  return (patch === undefined ? base : patch) as T;
}

const LOG_PREFIX = "[lcs]";

/** stdout 留给 MCP 协议；所有日志走 stderr。 */
export function log(...args: unknown[]): void {
  console.error(LOG_PREFIX, ...args);
}

export function logError(...args: unknown[]): void {
  console.error(LOG_PREFIX, "ERROR", ...args);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 超时（${timeoutMs}ms）`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
