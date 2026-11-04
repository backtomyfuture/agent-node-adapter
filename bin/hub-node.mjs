#!/usr/bin/env node
// hub-node —— 通用节点适配器命令行入口。
// 子命令：
//   daemon  常驻守护进程（认领 → 拉起 → 回执 → 落日志）
//   host    carrier 语境进程（设计 §9，M4 里程碑，尚未实现）
//   doctor  本机执行环境自检（局域网可达性 / context 建议，M3 里程碑，尚未实现）
// 配置目录：--config <dir>，或环境变量 HUB_NODE_HOME，默认 ~/.hub-node。
// 配置目录内含 node.json（节点身份与总线参数）与 commands.json（能力 -> 命令模板）。

import os from "node:os";
import path from "node:path";
import { Kernel, loadConfig, DAEMON_VERSION } from "../src/kernel.mjs";

function configDirFrom(argv) {
  const i = argv.indexOf("--config");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.HUB_NODE_HOME) return process.env.HUB_NODE_HOME;
  return path.join(os.homedir(), ".hub-node");
}

process.on("unhandledRejection", (e) => {
  console.error(new Date().toISOString().slice(0, 19), "unhandledRejection:", e?.message ?? e);
});

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "daemon") {
  const cfg = loadConfig(configDirFrom(rest));
  await new Kernel(cfg).run();
} else if (cmd === "--version" || cmd === "-v") {
  console.log(DAEMON_VERSION);
} else {
  console.log(`hub-node ${DAEMON_VERSION}
用法：hub-node daemon [--config <dir>]
其余子命令（host / doctor）见 DESIGN.md 里程碑，尚未实现。`);
}
