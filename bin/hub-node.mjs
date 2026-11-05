#!/usr/bin/env node
// hub-node —— 通用节点适配器命令行入口。
// 子命令：
//   setup    一键配置向导：装/复用 lark-cli、发现 Base 表、写配置、自检、自启
//   daemon   常驻守护进程（认领 → 拉起 → 回执 → 落日志）
//   doctor   本机自检：配置、凭据、总线连通、能力登记、自启状态（M3）
//            --probe <host:port> 经在线 carrier 做一次只读 TCP 探测
//   service  注册/卸载开机自启：macOS launchd / Linux systemd 用户级（M3）
//   host     carrier 语境进程：在用户终端里常驻，替守护进程代跑需要
//            特殊语境（如 macOS 局域网权限）的命令（设计 §9，M4）
// 配置目录：--config <dir>，或环境变量 HUB_NODE_HOME，默认 ~/.hub-node。
// 配置目录内含 node.json（节点身份与总线参数）与 commands.json（能力 -> 命令模板）。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Kernel, loadConfig, DAEMON_VERSION } from "../src/kernel.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function configDirFrom(argv) {
  const i = argv.indexOf("--config");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.HUB_NODE_HOME) return process.env.HUB_NODE_HOME;
  return path.join(os.homedir(), ".hub-node");
}

function probeTargetFrom(argv) {
  const i = argv.indexOf("--probe");
  if (i < 0) return undefined;
  return argv[i + 1] ?? "";
}

// launchd KeepAlive 会在进程一退出就拉起。配置错误若立刻退出，会毫秒级刷屏。
function configErrorBackoffMs() {
  const raw = process.env.HUB_CONFIG_ERROR_BACKOFF_MS;
  if (raw == null || String(raw).trim() === "") return 5000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5000;
  return Math.floor(n);
}

function readableConfigError(e, configDir) {
  const file = path.join(configDir, "node.json");
  if (e instanceof SyntaxError || e?.name === "SyntaxError") {
    const at = String(e.message).match(/position \d+ \(line \d+ column \d+\)/);
    return `${file} JSON 语法损坏${at ? "，" + at[0] : ""}`;
  }
  if (e?.code === "ENOENT") return `配置文件不可读：${e.message}`;
  return e?.message ? String(e.message) : String(e);
}

function acquireDaemonLock(configDir) {
  const lockPath = path.join(configDir, "daemon.lock");
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stat, pid;
      try {
        stat = fs.statSync(lockPath);
        pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      // 空文件可能是另一进程刚抢到锁、尚未写完；宁可拒绝启动，不误删活锁。
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`daemon 锁无有效 pid，请确认无守护进程后清理：${lockPath}`);
      }
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code !== "ESRCH") throw new Error(`daemon 锁 pid ${pid} 无法确认已退出：${e.code}`);
        try {
          if (sameFile(stat, fs.statSync(lockPath))) fs.unlinkSync(lockPath);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        continue;
      }
      throw new Error(`daemon 已在运行（pid ${pid}，锁：${lockPath}）`);
    }
    try {
      fs.writeFileSync(fd, String(process.pid) + "\n");
      const stat = fs.fstatSync(fd);
      return () => {
        try {
          if (sameFile(stat, fs.statSync(lockPath))) fs.unlinkSync(lockPath);
        } catch (e) {
          if (e.code !== "ENOENT") console.error("daemon 锁清理失败：" + e.message);
        }
      };
    } catch (e) {
      fs.unlinkSync(lockPath);
      throw e;
    } finally {
      fs.closeSync(fd);
    }
  }
  throw new Error(`daemon 锁竞争未完成，请稍后重试：${lockPath}`);
}

process.on("unhandledRejection", (e) => {
  console.error(new Date().toISOString().slice(0, 19), "unhandledRejection:", e?.message ?? e);
});

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "setup") {
  const { runSetup } = await import("../src/setup.mjs");
  process.exitCode = await runSetup(configDirFrom(rest), rest, APP_DIR);
} else if (cmd === "daemon") {
  let release;
  const onSignal = (signal) => process.exit(signal === "SIGINT" ? 130 : 143);
  try {
    const configDir = path.resolve(configDirFrom(rest));
    release = acquireDaemonLock(configDir);
    process.once("exit", release);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let cfg = null;
    try {
      cfg = loadConfig(configDir);
    } catch (e) {
      const backoffMs = configErrorBackoffMs();
      const ts = new Date().toISOString().slice(0, 19);
      console.error(`${ts} 配置加载失败：${readableConfigError(e, configDir)}`);
      console.error(`守护进程将退避 ${backoffMs}ms 后以非零状态退出，避免 launchd KeepAlive 毫秒级重启刷屏。请修正配置后再启动。`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      process.exitCode = 1;
    }
    if (cfg) await new Kernel(cfg).run();
  } catch (e) {
    console.error("daemon 启动失败：" + e.message);
    process.exitCode = 1;
  } finally {
    if (release) {
      release();
      process.removeListener("exit", release);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
} else if (cmd === "doctor") {
  const { doctor } = await import("../src/doctor.mjs");
  process.exitCode = await doctor(configDirFrom(rest), APP_DIR, { probe: probeTargetFrom(rest) });
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
  hub-node setup   [--config <dir>]    一键配置向导（首次装机跑这个）
  hub-node daemon  [--config <dir>]    常驻守护进程
  hub-node doctor  [--config <dir>] [--probe <host:port>]  本机自检
  hub-node service [--config <dir>]    注册开机自启（--remove 卸载）
  hub-node host    [--config <dir>]    carrier 语境进程（在终端里常驻代跑）`);
}
