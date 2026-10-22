/** 保留策略（GC）：终态 task 的 dsh 会话/产物到期清理；非终态不删。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gcExpired } from "../gc.js";
import { Store } from "../store.js";
import { makeTask, tmpDir } from "./helpers.js";

function sessionDir(sessionId: string): string {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
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
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const stateFile = path.join(dir, "state.json");
    const store = Store.open(stateFile);
    const config = {
      engine: {
        sessionRetentionDays: 1,
        artifactsDir: path.join(dir, "artifacts"),
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

    const oldDir = sessionDir("session-old");
    const liveDir = sessionDir("session-live");
    fs.mkdirSync(path.join(dir, "artifacts", done.id), { recursive: true });

    const result = gcExpired(config, store, Date.now());
    assert.equal(result.removedSessions, 1);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(liveDir), true, "非终态 task 的会话不能删");
    assert.equal(fs.existsSync(path.join(dir, "artifacts", done.id)), false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
