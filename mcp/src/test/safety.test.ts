/**
 * 执行器家目录安全校验（2026-10-22 事故的防复发测试）。
 *
 * 事故根因是「共享 ~/.dsh + 按目录扫描删除」。收紧后我们不仅要拒绝 `~/.dsh` 本身，
 * 还要堵住两种绕过：**符号链接** 和 **未展开的 `~`**。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isSameOrInside, realpathLoose, unsafeDshHomeReason } from "../safety.js";
import { defaultConfig } from "../config.js";
import { tmpDir } from "./helpers.js";

test("安全校验：独立的执行器家目录通过", () => {
  const home = tmpDir("lcs-safe-");
  assert.equal(unsafeDshHomeReason(path.join(home, ".lcs", "dsh-home"), home), null);
});

test("安全校验：~/.dsh 本身与它的子目录一律拒绝", () => {
  const home = tmpDir("lcs-safe-");
  assert.match(String(unsafeDshHomeReason(path.join(home, ".dsh"), home)), /~\/\.dsh/);
  assert.match(
    String(unsafeDshHomeReason(path.join(home, ".dsh", "sessions"), home)),
    /~\/\.dsh/,
  );
});

test("安全校验：符号链接指向 ~/.dsh 也拒绝（字符串比对会被绕过）", () => {
  const home = tmpDir("lcs-safe-");
  const realDsh = path.join(home, ".dsh");
  fs.mkdirSync(realDsh, { recursive: true });
  const link = path.join(home, ".lcs", "dsh-home");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(realDsh, link, "dir");

  // 表面上看是 ~/.lcs/dsh-home，实际指向 ~/.dsh —— 必须拒绝
  assert.notEqual(path.resolve(link), path.resolve(realDsh));
  assert.match(String(unsafeDshHomeReason(link, home)), /~\/\.dsh/);
});

test("安全校验：未展开的 `~` 不会被当成「另一个目录」放过", () => {
  const real = os.homedir();
  // 用真实家目录构造：`~/.dsh` 这种字面量必须解析成 用户家目录/.dsh 再判断
  assert.match(String(unsafeDshHomeReason("~/.dsh", real)), /~\/\.dsh/);
  // 合法路径里的 `~` 也应当被正确展开（不是当成相对路径）
  assert.equal(unsafeDshHomeReason("~/.lcs/dsh-home", real), null);
  // 家目录本身 / 根目录也不允许当执行器家目录
  assert.match(String(unsafeDshHomeReason(real, real)), /家目录/);
  assert.match(String(unsafeDshHomeReason("/", real)), /根目录|家目录/);
});

test("realpathLoose：不存在的路径也能解析到真实祖先", () => {
  const home = tmpDir("lcs-safe-");
  const notYet = path.join(home, "a", "b", "c");
  assert.equal(realpathLoose(notYet), notYet);
  // 祖先里有符号链接时，前缀被解析、剩余段保持原样
  const realDir = path.join(home, "real");
  fs.mkdirSync(realDir, { recursive: true });
  const link = path.join(home, "link");
  fs.symlinkSync(realDir, link, "dir");
  assert.equal(realpathLoose(path.join(link, "x", "y")), path.join(realDir, "x", "y"));
});

test("isSameOrInside：包含关系判断（不吃前缀巧合）", () => {
  assert.equal(isSameOrInside("/a/b", "/a/b"), true);
  assert.equal(isSameOrInside("/a/b/c", "/a/b"), true);
  assert.equal(isSameOrInside("/a/bc", "/a/b"), false);
  assert.equal(isSameOrInside("/a", "/a/b"), false);
});

test("配置校验：危险 dshHome 在启动那一刻就被拒绝", async () => {
  const { validateConfig } = await import("../config.js");
  const home = tmpDir("lcs-safe-");
  // 指向真实用户的 ~/.dsh（只做校验，不写任何东西）
  const config = defaultConfig();
  config.engine.dshHome = path.join(os.homedir(), ".dsh");
  assert.throws(() => validateConfig(config), /dshHome|~\/\.dsh/);
  // 未展开的 `~` 同样要被拦下（旧实现会把它当相对路径而放过）
  config.engine.dshHome = "~/.dsh";
  assert.throws(() => validateConfig(config), /~\/\.dsh/);
  config.engine.dshHome = path.join(home, ".lcs", "dsh-home");
  assert.doesNotThrow(() => validateConfig(config));
});
