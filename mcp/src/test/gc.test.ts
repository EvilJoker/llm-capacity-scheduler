/** 保留策略（GC）：终态 task 自己的 dsh 会话/产物到期清理；非终态不删；**别人的会话绝不删**。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gcExpired } from "../gc.js";

const WED_14_35 = new Date(2026, 9, 21, 14, 35).getTime();
import { Store } from "../store.js";
import { buildEngine, FakeClock, makeConfig, makeTask, tmpDir } from "./helpers.js";

function sessionDir(home: string, sessionId: string): string {
  const dir = path.join(home, "sessions", "--tmp-lcs-test--", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), "x");
  const proj = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
  fs.mkdirSync(path.dirname(proj), { recursive: true });
  fs.writeFileSync(proj, "{}");
  return dir;
}

test("GC：终态超期 → 删会话/投影/产物；未终态不删", () => {
  const dir = tmpDir("lcs-gc-");
  const home = path.join(dir, "dsh-home");
  const stateFile = path.join(dir, "state.json");
  const store = Store.open(stateFile);
  const config = {
    engine: {
      sessionRetentionDays: 1,
      artifactsDir: path.join(dir, "artifacts"),
      dshHome: home,
    },
  } as never;

  // submit 只接受新任务（state=submitted），终态/在飞由 transition 驱动
  const done = makeTask();
  const running = makeTask();
  store.submit(done);
  store.submit(running);
  const old = Date.now() - 3 * 24 * 3600 * 1000;
  assert.ok(
    store.transition(done.id, ["submitted"], "succeeded", {
      finishedAt: old,
      checkpoint: { sessionId: "session-old", updatedAt: Date.now() },
    }),
  );
  assert.ok(
    store.transition(running.id, ["submitted"], "running", {
      finishedAt: old,
      checkpoint: { sessionId: "session-live", updatedAt: Date.now() },
    }),
  );
  store.persist();

  const oldDir = sessionDir(home, "session-old");
  const liveDir = sessionDir(home, "session-live");
  fs.mkdirSync(path.join(dir, "artifacts", done.id), { recursive: true });

  const result = gcExpired(config, store, Date.now());
  assert.equal(result.removedSessions, 1);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(liveDir), true, "非终态 task 的会话不能删");
  assert.equal(fs.existsSync(path.join(dir, "artifacts", done.id)), false);
});

test("GC：不属于 LCS 的会话一律不删（2026-10-22 事故回归测试）", () => {
  const dir = tmpDir("lcs-gc-foreign-");
  const home = path.join(dir, "dsh-home");
  const store = Store.open(path.join(dir, "state.json"));
  const config = {
    engine: {
      sessionRetentionDays: 1,
      artifactsDir: path.join(dir, "artifacts"),
      dshHome: home,
    },
  } as never;

  // 一个「用户自己的」会话：不在 store 里、mtime 很旧
  const foreign = sessionDir(home, "session-user-own");
  const foreignProj = path.join(home, "storages", "session_projcache", "sessions", "session-user-own.json");
  const ancient = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  fs.utimesSync(foreign, ancient, ancient);

  // 一个终态但保留期未到的 LCS 会话
  const keep = makeTask();
  store.submit(keep);
  store.transition(keep.id, ["submitted"], "succeeded", {
    finishedAt: Date.now(),
    checkpoint: { sessionId: "session-fresh", updatedAt: Date.now() },
  });
  const freshDir = sessionDir(home, "session-fresh");

  const result = gcExpired(config, store, Date.now());
  assert.equal(result.removedSessions, 0, "没有到期任务就不该删任何会话");
  assert.equal(fs.existsSync(foreign), true, "陌生会话绝不能被删（用户 dsh web 的会话）");
  assert.equal(fs.existsSync(foreignProj), true, "陌生会话的投影缓存也不能删");
  assert.equal(fs.existsSync(freshDir), true, "保留期未到的会话不能删");
});

test("GC：只碰 engine.dshHome，绝不碰用户家目录", () => {
  const dir = tmpDir("lcs-gc-isolated-");
  const home = path.join(dir, "dsh-home");
  const userHome = path.join(dir, "user-dsh-home");
  const store = Store.open(path.join(dir, "state.json"));
  const config = {
    engine: {
      sessionRetentionDays: 1,
      artifactsDir: path.join(dir, "artifacts"),
      dshHome: home,
    },
  } as never;

  // 用户家目录里放一个老会话；LCS 的家目录是另一个
  const userSession = sessionDir(userHome, "session-user-in-home");
  const ancient = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  fs.utimesSync(userSession, ancient, ancient);

  const done = makeTask();
  store.submit(done);
  store.transition(done.id, ["submitted"], "succeeded", {
    finishedAt: Date.now() - 3 * 24 * 3600 * 1000,
    checkpoint: { sessionId: "session-lcs", updatedAt: Date.now() },
  });
  const lcsSession = sessionDir(home, "session-lcs");

  const result = gcExpired(config, store, Date.now());
  assert.equal(result.removedSessions, 1, "只删 LCS 自己的到期会话");
  assert.equal(fs.existsSync(lcsSession), false);
  assert.equal(fs.existsSync(userSession), true, "用户家目录的会话不在 GC 作用域内");
});

test("配置：engine.dshHome 指向 ~/.dsh 时直接拒绝启动", async () => {
  const { validateConfig, defaultConfig } = await import("../config.js");
  const config = defaultConfig();
  config.engine.dshHome = path.join(os.homedir(), ".dsh");
  assert.throws(() => validateConfig(config), /dshHome/);
});

test("GC dry-run：只预览不删除，报明细与陌生会话数", () => {
  const dir = tmpDir("lcs-gc-dry-");
  const home = path.join(dir, "dsh-home");
  const store = Store.open(path.join(dir, "state.json"));
  const config = {
    engine: { sessionRetentionDays: 1, artifactsDir: path.join(dir, "artifacts"), dshHome: home },
  } as never;

  const done = makeTask();
  store.submit(done);
  store.transition(done.id, ["submitted"], "succeeded", {
    finishedAt: Date.now() - 3 * 24 * 3600 * 1000,
    checkpoint: { sessionId: "session-old", updatedAt: Date.now() },
  });
  const oldDir = sessionDir(home, "session-old");
  fs.mkdirSync(path.join(dir, "artifacts", done.id), { recursive: true });
  const foreign = sessionDir(home, "session-unknowable");

  const dry = gcExpired(config, store, Date.now(), { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.details.length, 1);
  assert.equal(dry.details[0].taskId, done.id);
  assert.equal(dry.removedSessions, 1, "预览应报出「会删」数量");
  assert.equal(fs.existsSync(oldDir), true, "预览不能真的删");
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(dry.foreignSessions, 1, "陌生会话只统计不删");

  // 真跑：只删自己的，陌生会话仍在
  const real = gcExpired(config, store, Date.now());
  assert.equal(real.dryRun, false);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(foreign), true);
});

test("GC 审计：engine.runGc 把每次动作写进 store.gcLog", () => {
  const dir = tmpDir("lcs-gc-audit-");
  const clock = new FakeClock(WED_14_35);
  const config = makeConfig({ dir });
  config.engine.sessionRetentionDays = 7;
  const engine = buildEngine(config, clock, dir);
  const home = config.engine.dshHome;

  const done = makeTask();
  engine.store.submit(done);
  engine.store.transition(done.id, ["submitted"], "succeeded", {
    finishedAt: WED_14_35 - 10 * 24 * 3600 * 1000,
    checkpoint: { sessionId: "session-audit", updatedAt: WED_14_35 },
  });
  const dirS = sessionDir(home, "session-audit");

  const dry = engine.runGc({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(engine.store.gcLog.length, 1);
  assert.equal(engine.store.gcLog[0].dryRun, true);
  assert.equal(engine.store.gcLog[0].taskId, done.id);
  assert.equal(fs.existsSync(dirS), true, "预览不删");

  engine.runGc({});
  assert.equal(engine.store.gcLog.length, 2);
  assert.equal(engine.store.gcLog[0].dryRun, false, "最新在前");
  assert.equal(fs.existsSync(dirS), false);
  assert.ok(engine.recentGc(10).length >= 1);
});
