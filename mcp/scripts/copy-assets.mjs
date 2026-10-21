/** 把 Web 静态资源复制到 dist（tsc 不处理非 TS 文件）。 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "src", "web", "public");
const dst = path.join(root, "dist", "web", "public");
fs.mkdirSync(dst, { recursive: true });
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name));
}
console.log(`[lcs] web assets copied → ${path.relative(root, dst)}`);
