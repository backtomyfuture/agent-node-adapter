// doctor —— 节点自检：把「装完之后为什么跑不起来」变成一张清单。
// 检查 Node 版本、配置文件、凭据可达性、总线连通、能力登记与自启状态。
// 只读操作；凭据只校验存在与可用，绝不打印明文。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, DAEMON_VERSION } from "./kernel.mjs";
import { f1 } from "./bus/feishu.mjs";

const ok = (msg) => console.log("  ✓ " + msg);
const bad = (msg) => console.log("  ✗ " + msg);
const info = (msg) => console.log("  · " + msg);

export async function doctor(configDir, appDir) {
  let problems = 0;
  console.log(`hub-node doctor ${DAEMON_VERSION}`);
  console.log(`config dir: ${configDir}`);

  // 1. Node 版本（package.json engines: >=20）
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`node ${process.versions.node} (>= 20)`);
  else { bad(`node ${process.versions.node} 过低，需要 >= 20`); problems++; }

  // 2. 配置文件
  const nodeJsonPath = path.join(configDir, "node.json");
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(nodeJsonPath, "utf8"));
    ok("node.json 可解析");
  } catch (e) {
    bad(`node.json 读不了：${e.message}`);
    problems++;
  }
  if (raw) {
    const placeholder = (v) => typeof v === "string" && v.startsWith("<");
    if (!raw.node || placeholder(raw.node)) { bad("node.json 的 node 未填"); problems++; }
    if (!raw.baseToken || placeholder(raw.baseToken)) { bad("node.json 的 baseToken 未填（还是示例占位符）"); problems++; }
    for (const k of ["tasks", "messages", "parts", "runs", "artifacts", "agentCards"]) {
      if (!raw.tables?.[k] || placeholder(raw.tables[k])) { bad(`node.json 的 tables.${k} 未填`); problems++; }
    }
  }
  try {
    const cmds = JSON.parse(fs.readFileSync(path.join(configDir, "commands.json"), "utf8"));
    const names = Object.keys(cmds);
    ok(`commands.json：${names.length} 项能力（${names.join(", ")}）`);
    for (const [name, entry] of Object.entries(cmds)) {
      if (!entry.command) { bad(`能力 ${name} 缺 command 模板`); problems++; }
    }
  } catch (e) {
    bad(`commands.json 读不了：${e.message}`);
    problems++;
  }

  // 3. 依赖（事件订阅用的飞书 SDK）
  const sdkDir = path.join(appDir, "node_modules", "@larksuiteoapi", "node-sdk");
  if (fs.existsSync(sdkDir)) ok("依赖已安装（@larksuiteoapi/node-sdk）");
  else { bad("依赖未安装：在 app 目录跑 npm install"); problems++; }

  // 4-6. 凭据与总线（loadConfig 成功 = 凭据齐备；再实测 token 与读表）
  let cfg = null;
  try {
    cfg = loadConfig(configDir);
    ok(`凭据可读（节点 ${cfg.node}，app_id 已配置）`);
  } catch (e) {
    bad(`凭据不可用：${e.message}`);
    problems++;
  }
  if (cfg) {
    try {
      await cfg.bus.tenantToken();
      ok("飞书 tenant token 获取成功");
    } catch (e) {
      bad(`tenant token 失败：${e.message}`);
      problems++;
    }
    try {
      const cards = await cfg.bus.listRecords(cfg.bus.tables.agentCards);
      const mine = cards.filter((r) => f1(r, "Node") === cfg.node);
      ok(`AgentCards 可读：本节点已登记 ${mine.length} 项能力`);
      const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
      ok(`Tasks 可读：共 ${tasks.length} 条`);
    } catch (e) {
      bad(`读表失败：${e.message}`);
      problems++;
    }
    info(cfg.events
      ? `唤醒方式：事件订阅（长连接）＋ ${cfg.sweepSec}s 对账兜底`
      : `唤醒方式：轮询 ${cfg.pollSec}s（事件订阅已关）`);
  }

  // 7. 自启状态（只报告，不动手）
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("launchctl", ["list"], { encoding: "utf8" });
      const mine = out.split("\n").filter((l) => l.includes("hub-node") || l.includes("agenthub"));
      if (mine.length) ok(`launchd 自启在册：${mine.map((l) => l.trim().split(/\s+/).pop()).join(", ")}`);
      else info("未发现 hub-node 的 launchd 自启（可用 hub-node service 安装）");
    } else if (process.platform === "linux") {
      const units = fs.existsSync(path.join(os.homedir(), ".config/systemd/user"))
        ? fs.readdirSync(path.join(os.homedir(), ".config/systemd/user")).filter((f) => f.startsWith("hub-node"))
        : [];
      if (units.length) ok(`systemd 用户单元在册：${units.join(", ")}`);
      else info("未发现 hub-node 的 systemd 用户单元（可用 hub-node service 安装）");
    }
  } catch { /* 自启状态查不到不算失败 */ }

  console.log(problems ? `doctor: ${problems} 个问题` : "doctor: 全部通过");
  return problems ? 1 : 0;
}
