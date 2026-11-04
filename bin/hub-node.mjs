#!/usr/bin/env node
// hub-node —— 通用节点适配器命令行入口。
// 子命令：
//   daemon   常驻守护进程（认领 → 拉起 → 回执 → 落日志）
//   doctor   本机自检：配置、凭据、总线连通、能力登记、自启状态（M3）
//   service  注册/卸载开机自启：macOS launchd / Linux systemd 用户级（M3）
//   host     carrier 语境进程：在用户终端里常驻，替守护进程代跑需要
//            特殊语境（如 macOS 局域网权限）的命令（设计 §9，M4）
// 配置目录：--config <dir>，或环境变量 HUB_NODE_HOME，默认 ~/.hub-node。
// 配置目录内含 node.json（节点身份与总线参数）与 commands.json（能力 -> 命令模板）。

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, loadConfig, DAEMON_VERSION } from "../src/kernel.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
} else if (cmd === "doctor") {
  const { doctor } = await import("../src/doctor.mjs");
  process.exitCode = await doctor(configDirFrom(rest), APP_DIR);
} else if (cmd === "host") {
  const { startCarrier } = await import("../src/carrier.mjs");
  process.exitCode = await startCarrier(configDirFrom(rest));
} else if (cmd === "service") {
  const { service } = await import("../src/service.mjs");
  process.exitCode = await service(configDirFrom(rest), { remove: rest.includes("--remove") }, APP_DIR);
} else if (cmd === "--version" || cmd === "-v") {
  console.log(DAEMON_VERSION);
} else {
  console.log(`hub-node ${DAEMON_VERSION}
用法：
  hub-node daemon  [--config <dir>]    常驻守护进程
  hub-node doctor  [--config <dir>]    本机自检
  hub-node service [--config <dir>]    注册开机自启（--remove 卸载）
  hub-node host    [--config <dir>]    carrier 语境进程（在终端里常驻代跑）`);
}
