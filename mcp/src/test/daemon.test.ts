/**
 * 命令行/常驻服务生命周期：`init` → `start` → `status` → `stop`，以及 `init` 的首次体验。
 *
 * 这是「装完能不能直接用」的验收：用户不需要自己写 nohup，也不该在第一次 doctor
 * 就看到一个「有厂商但没 Key」的红色失败项。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exampleConfig, saveConfig } from "../config.js";
import { runDoctor } from "../doctor.js";
import { tmpDir } from "./helpers.js";

const BIN = fileURLToPath(new URL("../../bin/lcs-mcp.js", import.meta.url));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeout = 30000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { timeout, env: { ...process.env } },
      (error, stdout, stderr) => {
        resolve({
          code: typeof (error as { code?: number } | null)?.code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 写一份指向临时目录的配置（零厂商也能跑，正好验证首次体验）。 */
async function writeTestConfig(dir: string): Promise<{ configPath: string; port: number }> {
  const port = await freePort();
  const config = exampleConfig();
  config.engine.stateFile = path.join(dir, "state.json");
  config.engine.artifactsDir = path.join(dir, "artifacts");
  config.engine.workDir = path.join(dir, "work");
  config.engine.dshHome = path.join(dir, "dsh-home");
  config.engine.tickSeconds = 5;
  config.engine.web.port = port;
  const configPath = path.join(dir, "config.json");
  saveConfig(config, configPath);
  return { configPath, port };
}

test("init：生成零厂商配置，并给出三步上手指引", async () => {
  const dir = tmpDir("lcs-init-");
  const configPath = path.join(dir, "config.json");
  const result = await runCli(["init", "--config", configPath]);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    providers?: unknown[];
  };
  assert.deepEqual(config.providers, [], "init 不应预置没有 Key 的厂商");
  assert.match(result.stdout, /lcs-mcp start/);
  assert.match(result.stdout, /添加厂商/);
});

test("doctor：零厂商时只是 warn（不是一上来就红的失败）", async () => {
  const dir = tmpDir("lcs-doctor-");
  const { configPath } = await writeTestConfig(dir);
  const checks = await runDoctor({
    configPath,
    fetchHealth: async () => false,
    run: () => "dsh 0.2.0-rc.2",
  });
  const creds = checks.find((check) => check.name === "厂商凭据");
  assert.ok(creds);
  assert.equal(creds.level, "warn", creds.detail);
  assert.match(String(creds.hint), /添加 LLM/);
  const isolation = checks.find((check) => check.name === "执行器家目录隔离");
  assert.equal(isolation?.level, "ok");
});

test("守护进程：start → status → stop 全链路（后台常驻 + 日志 + 单实例）", { timeout: 90000 }, async () => {
  const dir = tmpDir("lcs-daemon-");
  const { configPath, port } = await writeTestConfig(dir);
  try {
    const start = await runCli(["start", "--config", configPath], 40000);
    assert.equal(start.code, 0, `start 失败\nstdout=${start.stdout}\nstderr=${start.stderr}`);
    assert.match(start.stdout, /已启动/);

    // 健康检查确实通了
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.ok, true);

    const status = await runCli(["status", "--config", configPath]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /运行中/);
    assert.match(status.stdout, /调度器/);

    // 重复 start 不应该再拉起第二个实例
    const again = await runCli(["start", "--config", configPath]);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /已在运行/);

    // doctor 也要能认出在跑的实例（即便启动时用了 --port 覆盖）
    const checks = await runDoctor({ configPath });
    const daemonCheck = checks.find((check) => check.name === "守护进程");
    assert.equal(daemonCheck?.level, "ok", daemonCheck?.detail);
    assert.match(String(daemonCheck?.detail), new RegExp(`:${port}`));

    // 日志落盘
    const logFile = path.join(dir, "logs", "lcs.log");
    assert.equal(fs.existsSync(logFile), true, "后台日志应写在 <state 目录>/logs/lcs.log");
    assert.ok(fs.statSync(logFile).size > 0);
    const logs = await runCli(["logs", "--config", configPath, "--tail", "20"]);
    assert.equal(logs.code, 0, logs.stderr);
    assert.ok(logs.stdout.trim().length > 0);
  } finally {
    const stop = await runCli(["stop", "--config", configPath], 30000);
    assert.equal(stop.code, 0, stop.stderr);
    // 停完之后端口应该真的没人听了
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    const statusAfter = await runCli(["status", "--config", configPath]);
    assert.equal(statusAfter.code, 1);
    assert.match(statusAfter.stdout, /没在运行/);
  }
});
