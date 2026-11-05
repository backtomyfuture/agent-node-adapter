// doctor —— 节点自检：把「装完之后为什么跑不起来」变成一张清单。
// 检查 Node 版本、配置文件、凭据可达性、总线连通、能力登记与自启状态。
// 只读操作；凭据只校验存在与可用，绝不打印明文。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, DAEMON_VERSION } from "./kernel.mjs";
import { f1 } from "./bus/feishu.mjs";
import { execViaCarrier, pingCarrier } from "./carrier.mjs";

const ok = (msg) => console.log("  ✓ " + msg);
const bad = (msg) => console.log("  ✗ " + msg);
const info = (msg) => console.log("  · " + msg);

// ping 只证明本机 unix socket 上有 carrier 在听。DESIGN §9 注记④：长驻进程的
// 局域网裸 TCP 仍可能失败，所以默认报告必须把「socket 在线」和「目标可达」拆开。
const SOCKET_ONLINE = "carrier socket 在线（局域网目标可达性未验证，可加 --probe <host:port> 探测）";

function parseProbeTarget(raw) {
  const s = String(raw ?? "").trim();
  let host, portText;
  const bracket = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) {
    host = bracket[1];
    portText = bracket[2];
  } else {
    const i = s.lastIndexOf(":");
    if (i <= 0 || i === s.length - 1) return null;
    host = s.slice(0, i);
    portText = s.slice(i + 1);
  }
  if (!host || host.length > 253 || host.startsWith("-")) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return null;
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

// 经 carrier 做一次只读 TCP 握手。目标只作为已校验的 argv 传入，不进 shell 元字符。
async function probeLan(socketPath, host, port) {
  const script = 'const n=require("net");const h=process.argv[1];const p=Number(process.argv[2]);const s=n.createConnection({host:h,port:p});s.setTimeout(5000,()=>{s.destroy();process.exit(2)});s.on("error",()=>process.exit(1));s.on("connect",()=>{s.end();process.exit(0)})';
  const command = `node -e '${script}' -- ${host} ${port}`;
  try {
    const r = await execViaCarrier(socketPath, { command, timeoutSec: 8 });
    if (r.code === 0) return { ok: true, detail: "" };
    const extra = (r.stderr || r.stdout || "").trim().replace(/\s+/g, " ").slice(0, 160);
    return { ok: false, detail: `退出码 ${r.code ?? "null"}${extra ? " " + extra : ""}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

export async function doctor(configDir, appDir, opts = {}) {
  let problems = 0;
  const probeProvided = opts.probe != null;
  const probe = probeProvided ? parseProbeTarget(opts.probe) : null;
  console.log(`hub-node doctor ${DAEMON_VERSION}`);
  console.log(`config dir: ${configDir}`);
  if (probeProvided && !probe) {
    bad(`--probe 需要 <host:port>（例如 192.168.1.10:22），收到：${opts.probe === "" ? "(空)" : opts.probe}`);
    problems++;
  }

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
    // carrier 语境（设计 §9）：有 context=carrier 的能力，或显式 --probe 时才检查。
    // socket 探活成功只说明本机 carrier 在听，不宣称局域网可达。
    try {
      const cmds = JSON.parse(fs.readFileSync(path.join(configDir, "commands.json"), "utf8"));
      const carrierCaps = Object.entries(cmds).filter(([, e]) => e.context === "carrier").map(([k]) => k);
      if (carrierCaps.length || probe) {
        const online = await pingCarrier(cfg.carrierSocket);
        if (!online) {
          const caps = carrierCaps.length ? `能力 ${carrierCaps.join(", ")} 将标离线；` : "";
          const via = probe ? `无法探测 ${probe.host}:${probe.port}；` : "";
          bad(`carrier 离线：${caps}${via}请在终端里跑 hub-node host`);
          problems++;
        } else if (!probe) {
          ok(SOCKET_ONLINE);
          if (carrierCaps.length) info(`carrier 能力：${carrierCaps.join(", ")}`);
        } else {
          ok("carrier socket 在线，经其执行只读 TCP 探测");
          if (carrierCaps.length) info(`carrier 能力：${carrierCaps.join(", ")}`);
          const reached = await probeLan(cfg.carrierSocket, probe.host, probe.port);
          const target = `${probe.host}:${probe.port}`;
          if (reached.ok) ok(`局域网目标 ${target} 可达（经 carrier 只读 TCP 探测）`);
          else {
            bad(`局域网目标 ${target} 不可达（经 carrier 只读 TCP 探测）${reached.detail ? "：" + reached.detail : ""}`);
            problems++;
          }
        }
      }
    } catch { /* commands.json 已在前面报过 */ }
  }
  if (probe && !cfg) {
    bad(`无法探测 ${probe.host}:${probe.port}：配置未加载，不知道 carrier socket 路径`);
    problems++;
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
