import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const supported = new Set(["managed.test.mjs", "protocol.test.mjs"]);
const selected = fs.readdirSync(path.join(root, "tests"))
  .filter((name) => supported.has(name))
  .map((name) => path.join(root, "tests", name));
process.stdout.write("运行当前对外提供的托管桥接器与 MCP 协议检查；旧 consult 接口测试仅供历史参考。\n");
const result = spawnSync(process.execPath, ["--test", ...selected], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
