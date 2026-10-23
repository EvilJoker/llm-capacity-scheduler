/**
 * 路径安全：执行器家目录隔离校验（2026-10-22 会话被删事故后的硬约束）。
 *
 * 为什么单独一个文件：这个判断被三处复用（配置校验 / GC / doctor），必须只有一份实现，
 * 否则很容易出现「启动时校验的是 `/home/u/.dsh`，GC 时比对的是字符串 `~/.dsh`」这种绕过。
 *
 * 事故的绕过口（本文件要堵的就是它）：
 * - 字符串精确比对：`~/.lcs/dsh-home` 若是一个**指向 `~/.dsh` 的符号链接**，
 *   比对字符串时两者不同 → 校验通过 → GC 顺着符号链接进到用户的 `~/.dsh`。
 * - 未展开 `~`：配置里写 `"~/.dsh"` 时 `path.resolve` 会把它当相对路径，
 *   结果变成 `<cwd>/~/.dsh`，同样不等于 `/home/u/.dsh` → 绕过。
 *
 * 因此一律先 `realpath`（目标不存在时解析最近的已存在祖先），再按**路径包含关系**判断。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandHome } from "./util.js";

/**
 * 尽量解析真实路径：目标不存在时，解析最近的已存在祖先后把剩余段拼回去。
 * 这样「还没创建的隔离目录」也能和「已存在的符号链接」正确比较。
 */
export function realpathLoose(target: string): string {
  const abs = path.resolve(expandHome(target));
  let current = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs; // 到根了还不存在：原样返回
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** child 是否等于 parent，或位于 parent 之下（二者都应是绝对路径）。 */
export function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 用户自己 dsh 的家目录（LCS 绝对不允许碰）。 */
export function userDshHome(homedir: string = os.homedir()): string {
  return path.join(homedir, ".dsh");
}

/**
 * 校验 `engine.dshHome` 是否安全；返回**不安全的原因**，`null` 表示安全。
 *
 * 不安全的情况：
 * 1. 解析后等于 `~/.dsh` 或在它下面（事故同源：会扫到用户会话）；
 * 2. 解析后等于用户家目录本身（GC 的产物目录会落到家目录里）；
 * 3. 解析后是文件系统根目录。
 */
export function unsafeDshHomeReason(
  dshHome: unknown,
  homedir: string = os.homedir(),
): string | null {
  if (typeof dshHome !== "string" || dshHome.trim() === "") {
    return "engine.dshHome 不能为空";
  }
  const real = realpathLoose(dshHome);
  const shared = realpathLoose(userDshHome(homedir));
  if (isSameOrInside(real, shared)) {
    return (
      `engine.dshHome 不能是 ~/.dsh 本身或它的子目录（解析后：${real}）` +
      "：共享家目录会让 LCS 的清理扫到用户自己的 dsh 会话（2026-10-22 真实事故）"
    );
  }
  const realHome = realpathLoose(homedir);
  if (real === realHome) {
    return `engine.dshHome 不能是用户家目录本身（${real}）：执行器数据必须放在独立子目录里`;
  }
  if (real === path.parse(real).root) {
    return "engine.dshHome 不能是文件系统根目录";
  }
  return null;
}
