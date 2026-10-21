/** 库入口：把引擎/存储/MCP/Web 作为可编程组件暴露。 */

export { defaultConfig, loadConfig, redactConfig, saveConfig, validateConfig } from "./config.js";
export type { Config, EngineConfig, PolicyConfig, ProviderConfig } from "./config.js";
export { Engine } from "./engine.js";
export { buildTaskFromInput } from "./task-input.js";
export { createMcpServer, serveMcpStdio, VERSION } from "./mcp.js";
export { HttpBackend, LocalBackend } from "./backend.js";
export { Store } from "./store.js";
export { startWebServer } from "./web/server.js";
export { BurnBeforeExpiryPolicy, ReserveFunction, taskScore, UsageModel } from "./policy.js";
export { buildAdapters } from "./capacity/index.js";
export { buildRunners } from "./runner/index.js";
export * from "./types.js";
