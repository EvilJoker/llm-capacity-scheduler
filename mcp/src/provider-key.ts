/**
 * provider 凭据解析（共享）：容量观测与 dsh 执行都从这里取 Key，保证「烧的账号 = 记账的账号」。
 *
 * 优先级：apiKeyEnv（环境变量） > apiKey（配置内明文） > apiKeyFile（文件里的 api_key）。
 */

import fs from "node:fs";
import path from "node:path";

export function resolveProviderKey(options: Record<string, unknown>): string | null {
  const envName = typeof options.apiKeyEnv === "string" ? options.apiKeyEnv.trim() : "";
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  const direct = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  if (direct) return direct;
  const file = typeof options.apiKeyFile === "string" ? options.apiKeyFile.trim() : "";
  if (file) {
    try {
      const data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Record<string, unknown>;
      const key = data.api_key ?? data.apiKey ?? data.token;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      /* 读不到就继续 */
    }
  }
  return null;
}
