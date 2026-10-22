/** v0.3：配置迁移、厂商预设、dsh profile/patch、事件流解析。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { defaultConfig, migrateConfig, validateConfig } from "../config.js";
import { ensureDshProfile, renderProfilePatch, renderRunPatch } from "../dsh-profile.js";
import { findVendor, addProvider } from "../provider-presets.js";
import { parseDshEvents } from "../runner/events.js";
import { tmpDir } from "./helpers.js";

test("配置迁移 v1 → v2：dsh-only、串行、模型归 provider", () => {
  const v1 = {
    version: 1,
    engine: {
      tickSeconds: 30,
      stateFile: "~/.lcs/state.json",
      artifactsDir: "~/.lcs/artifacts",
      maxParallel: 4,
      web: { enabled: true, host: "127.0.0.1", port: 7788 },
    },
    providers: [
      {
        name: "minimax",
        kind: "minimax",
        enabled: true,
        options: { apiKey: "k", families: ["general"] },
      },
    ],
    models: [{ provider: "minimax", model: "old", family: "general" }],
    runners: {
      default: "shell",
      shell: { enabled: true },
      dsh: { enabled: true, command: "dsh", profile: "headless", profiles: {} },
    },
  };
  const migrated = migrateConfig(v1 as unknown as Record<string, unknown>);
  assert.equal(migrated.version, 2);
  const engine = migrated.engine as Record<string, unknown>;
  assert.equal(engine.maxParallel, 1);
  assert.equal(engine.workDir, "~/.lcs/work");
  assert.equal(engine.sessionRetentionDays, 7);
  const runners = migrated.runners as Record<string, unknown>;
  assert.equal(runners.default, "dsh");
  assert.equal("shell" in runners, false);
  const dsh = runners.dsh as Record<string, unknown>;
  assert.equal(dsh.profile, "lcs");
  assert.equal(dsh.patchDir, "~/.lcs/patches");
  assert.deepEqual(migrated.models, []);
  const providers = migrated.providers as { options: Record<string, unknown> }[];
  const dshOptions = providers[0].options.dsh as Record<string, unknown>;
  assert.equal(dshOptions.route, "minimax");
  assert.equal(dshOptions.apiKeyEnv, "LCS_MINIMAX_API_KEY");
  assert.ok(Array.isArray(dshOptions.models) && dshOptions.models.length > 0);
  // 幂等：v2 输入原样返回
  assert.equal(migrateConfig(migrated), migrated);
});

test("厂商预设：模型必须来自预设列表", () => {
  const vendor = findVendor("minimax");
  assert.ok(vendor);
  const config = defaultConfig();
  assert.throws(
    () => addProvider(config, { vendor: "minimax", apiKey: "k", model: "no-such-model" }),
    /不支持模型/,
  );
  assert.throws(() => addProvider(config, { vendor: "minimax", apiKey: "  " }), /API Key/);
  assert.throws(() => addProvider(config, { vendor: "openai", apiKey: "k" }), /暂不支持/);
});

test("厂商预设：addProvider 写入 dsh 路由与所选模型", () => {
  const config = defaultConfig();
  config.providers = [];
  const added = addProvider(config, { vendor: "minimax", apiKey: "k" });
  const provider = added.provider;
  const dsh = provider.options.dsh as Record<string, unknown>;
  assert.equal(provider.kind, "minimax");
  assert.equal(dsh.route, "minimax");
  assert.equal(dsh.apiKeyEnv, "LCS_MINIMAX_API_KEY");
  assert.ok((dsh.models as string[]).includes(dsh.defaultModel as string));
  // 预设里不含明文 Key 之外的敏感项；Key 只在 options.apiKey
  assert.equal(provider.options.apiKey, "k");
  assert.equal(provider.options.apiKeyEnv, "");
});

test("dsh profile patch：只声明路由，不含 Key", () => {
  const config = defaultConfig();
  const patch = renderProfilePatch([
    {
      route: "minimax",
      api: "anthropic-messages",
      baseURL: "https://api.minimaxi.com/anthropic",
      apiKeyEnv: "LCS_MINIMAX_API_KEY",
      models: ["MiniMax-M3.1-Flash[1m]"],
      defaultModel: "MiniMax-M3.1-Flash[1m]",
    },
  ]);
  assert.match(patch, /- id: llm-pi-ai/);
  assert.match(patch, /apiKeyEnv: "LCS_MINIMAX_API_KEY"/);
  assert.match(patch, /- id: "MiniMax-M3\.1-Flash\[1m\]"/);
  assert.equal(/sk-[A-Za-z0-9]/.test(patch), false);
});

test("运行期 patch：只覆盖 agent-default-model", () => {
  const patch = renderRunPatch("minimax", "MiniMax-M3.1-Flash[1m]");
  assert.match(patch, /- id: agent-default-model/);
  assert.match(patch, /provider: "minimax"/);
  assert.match(patch, /model: "MiniMax-M3\.1-Flash\[1m\]"/);
  assert.equal(patch.includes("llm-pi-ai"), false);
});

test("dsh profile 自举：幂等生成 profile 目录", () => {
  const dir = tmpDir("lcs-profile-");
  const home = path.join(dir, "dsh-home");
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const config = defaultConfig();
    const first = ensureDshProfile(config, "lcs");
    assert.equal(first.changed, true);
    assert.ok(fs.existsSync(path.join(first.dir, "package.json")));
    assert.ok(fs.existsSync(path.join(first.dir, "cordis.patch.yml")));
    const second = ensureDshProfile(config, "lcs");
    assert.equal(second.changed, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("事件流解析：session / usage / final / error", () => {
  const ok = parseDshEvents(
    [
      '{"type":"session","sessionId":"session-1","cwd":"/x"}',
      '{"type":"status","phase":"turn_start","turn":1}',
      '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":10,"outputTokens":2,"totalTokens":12}}',
      '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
      '{"type":"final","text":"答案"}',
      "不是 JSON 的行",
    ].join("\n"),
  );
  assert.equal(ok.sessionId, "session-1");
  assert.equal(ok.finalText, "答案");
  assert.equal(ok.hasFinal, true);
  assert.equal(ok.usage?.inputTokens, 10);
  assert.equal(ok.turnReason, "completed");
  assert.equal(ok.error, undefined);

  const failed = parseDshEvents(
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"AUTH","message":"401"}}}',
  );
  assert.equal(failed.error?.code, "AUTH");
  assert.equal(failed.turnReason, "error");
});

test("配置校验：v2 必填项与 dsh 段完整性", () => {
  const config = defaultConfig();
  validateConfig(config);
  const bad = defaultConfig();
  bad.version = 1 as unknown as 2;
  assert.throws(() => validateConfig(bad), /version/);
  const badModel = defaultConfig();
  badModel.providers[0].options.dsh = {
    route: "minimax",
    api: "anthropic-messages",
    baseURL: "https://x",
    apiKeyEnv: "LCS_X",
    models: ["a"],
    defaultModel: "b",
  };
  assert.throws(() => validateConfig(badModel), /defaultModel/);
});
