// setup —— 一键配置向导：把「装节点」的门槛压到一条命令。
// 做完的事：确认 lark-cli 在位（不在则用 npm 装）；复用 lark-cli 已配置的
// 飞书应用（凭据只在本机流转：配置文件 / macOS 钥匙串 -> 本机 app.env，
// 绝不打印明文）；向 Base 自动发现六张表的 ID 并写入 node.json；种子能力
// 只放 echo-test；最后跑 doctor 自检，可选顺带注册开机自启。
// 已有 lark-cli 配置是主路径；没有时给出确切的下一步（lark-cli config init）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync, execSync } from "node:child_process";
import { FeishuBus } from "./bus/feishu.mjs";
import { doctor } from "./doctor.mjs";
import { service } from "./service.mjs";

const REQUIRED_TABLES = ["Tasks", "Messages", "Parts", "Runs", "Artifacts", "AgentCards"];
const TABLE_KEYS = { Tasks: "tasks", Messages: "messages", Parts: "parts", Runs: "runs", Artifacts: "artifacts", AgentCards: "agentCards" };

function parseFlags(argv) {
  const f = { yes: false, force: false, service: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--force") f.force = true;
    else if (a === "--service") f.service = true;
    else if (a === "--base") f.base = argv[++i];
    else if (a === "--node") f.node = argv[++i];
    else if (a === "--zone") f.zone = argv[++i];
    else if (a === "--prefix") f.prefix = argv[++i];
    else if (a === "--desc") f.desc = argv[++i];
    else if (a === "--app-id") f.appId = argv[++i];
    else if (a === "--app-secret") f.appSecret = argv[++i];
  }
  return f;
}

function richPath() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")];
  const cur = (process.env.PATH || "").split(path.delimiter);
  return [...new Set([...extra, ...cur])].join(path.delimiter);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, PATH: richPath() }, ...opts });
}

function larkVersion() {
  try {
    return run("lark-cli", ["--version"]).trim();
  } catch {
    return null;
  }
}

function ensureLarkCli() {
  const v = larkVersion();
  if (v) {
    console.log(`  ✓ lark-cli 已安装（${v}）`);
    return true;
  }
  console.log("  · 未发现 lark-cli，正在通过 npm 安装 @larksuite/cli …");
  try {
    execSync("npm install -g @larksuite/cli", { stdio: "inherit", env: { ...process.env, PATH: richPath() } });
  } catch {
    console.error("  ✗ npm 安装 lark-cli 失败。请先确认 Node.js/npm 可用，再重跑 hub-node setup。");
    return false;
  }
  const v2 = larkVersion();
  if (!v2) {
    console.error("  ✗ lark-cli 安装后仍不可用（可能不在 PATH 中）。新开一个终端再试。");
    return false;
  }
  console.log(`  ✓ lark-cli 已安装（${v2}）`);
  return true;
}

function readLarkConfig() {
  const candidates = [
    path.join(os.homedir(), ".lark-cli", "config.json"),
    path.join(os.homedir(), ".config", "lark-cli", "config.json"),
  ];
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(d.apps) && d.apps.length) return { path: p, apps: d.apps };
    } catch { /* 下一个候选 */ }
  }
  return null;
}

// 从 lark-cli 的应用条目里解析出 secret 明文；只在本机内存里流转，绝不打印。
// 形态：明文字符串 / {"source":"keychain","id":...}（macOS 钥匙串引用）。
function resolveSecret(app) {
  const s = app?.appSecret;
  if (typeof s === "string" && s) return { value: s, source: "lark-cli 配置（明文）" };
  if (s && typeof s === "object" && s.source === "keychain" && s.id && process.platform === "darwin") {
    for (const args of [["find-generic-password", "-a", s.id, "-w"], ["find-generic-password", "-l", s.id, "-w"], ["find-generic-password", "-s", s.id, "-w"]]) {
      try {
        const out = run("security", args).replace(/\n$/, "");
        if (out) return { value: out, source: "macOS 钥匙串（经 lark-cli 引用）" };
      } catch { /* 换一种查法 */ }
    }
  }
  return null;
}

function extractBaseToken(input) {
  if (!input) return null;
  const m = String(input).match(/\/base\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const t = String(input).trim();
  return /^[A-Za-z0-9_-]{16,}$/.test(t) ? t : null;
}

export async function runSetup(configDir, argv, appDir) {
  const flags = parseFlags(argv);
  const interactive = !!process.stdin.isTTY && !flags.yes;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    if (!interactive) {
      if (def !== undefined) return def;
      throw new Error(`非交互模式缺少参数：${q}（请用命令行参数提供，或在终端里交互运行）`);
    }
    const a = (await rl.question(def !== undefined && def !== "" ? `${q} [${def}] ` : `${q} `)).trim();
    return a || def || "";
  };

  try {
    console.log("hub-node setup —— 一键配置节点");
    console.log(`config dir: ${configDir}`);

    // 1. lark-cli 在位（手工指定 --app-id/--app-secret 时可跳过）
    let larkCfg = null;
    if (!(flags.appId && flags.appSecret)) {
      if (!ensureLarkCli()) return 2;
      larkCfg = readLarkConfig();
      if (!larkCfg && !flags.appId) {
        console.error("  ✗ lark-cli 还没有配置任何飞书应用。");
        console.error("    先运行 `lark-cli config init` 按它的引导完成应用配置，再重跑 `hub-node setup`。");
        return 2;
      }
      if (larkCfg) console.log(`  ✓ 读到 lark-cli 配置：${larkCfg.path}（${larkCfg.apps.length} 个应用）`);
    }

    // 2. 选定应用并解析凭据
    let appId = flags.appId || null;
    let appEntry = null;
    if (larkCfg) {
      if (appId) appEntry = larkCfg.apps.find((a) => a.appId === appId) || null;
      else if (larkCfg.apps.length === 1) appEntry = larkCfg.apps[0];
      else {
        larkCfg.apps.forEach((a, i) => console.log(`    ${i + 1}. ${a.appId}${a.users?.[0]?.userName ? `（${a.users[0].userName}）` : ""}`));
        const pick = await ask("选择用作节点身份的应用序号", "1");
        appEntry = larkCfg.apps[Number(pick) - 1] || larkCfg.apps[0];
      }
      if (appEntry) appId = appEntry.appId;
    }
    if (!appId) throw new Error("未能确定应用：请用 --app-id 指定，或先完成 lark-cli 配置。");
    let secret = flags.appSecret || null;
    let secretSource = secret ? "命令行参数" : null;
    if (!secret && appEntry) {
      const r = resolveSecret(appEntry);
      if (r) { secret = r.value; secretSource = r.source; }
    }
    if (!secret) {
      secret = await ask(`粘贴应用 ${appId} 的 App Secret（只写入本机 app.env，权限 600，不会显示在任何日志里）`);
      secretSource = "手工粘贴";
      if (!secret) { console.error("  ✗ 没有 Secret 无法继续。"); return 2; }
    }
    console.log(`  ✓ 应用 ${appId}，凭据来源：${secretSource}`);

    // 3. Base 与表发现
    const baseInput = flags.base || (await ask("粘贴多维表格 Base 的链接（或直接给 token）"));
    const baseToken = extractBaseToken(baseInput);
    if (!baseToken) { console.error("  ✗ 没能从输入里解析出 Base token。"); return 2; }
    const bus = new FeishuBus({ appId, appSecret: secret, baseToken, tables: {} });
    let tableItems;
    try {
      const items = [];
      let page = null;
      for (;;) {
        const d = await bus.api("GET", `/bitable/v1/apps/${baseToken}/tables?page_size=100` + (page ? `&page_token=${page}` : ""));
        items.push(...(d.items ?? []));
        if (d.has_more) page = d.page_token; else break;
      }
      tableItems = items;
    } catch (e) {
      console.error(`  ✗ 读不到这个 Base 的表清单：${e.message}`);
      if (/tenant token failed/i.test(e.message)) {
        console.error("    凭据换不到 token：多半是 App Secret 不对，或应用未发布/未启用。核对开发者后台的应用凭据后重跑。");
      } else {
        console.error(`    若是无权限：请在该 Base 的分享设置里把应用 ${appId} 加为「可编辑」，再重跑 hub-node setup。`);
      }
      return 3;
    }
    const byName = new Map(tableItems.map((t) => [t.name, t.table_id]));
    const missing = REQUIRED_TABLES.filter((n) => !byName.has(n));
    if (missing.length) {
      console.error(`  ✗ Base 缺少标准表：${missing.join(", ")}（现有表：${[...byName.keys()].join(", ") || "无"}）。中台标准 Base 需含 Tasks/Messages/Parts/Runs/Artifacts/AgentCards 六表。`);
      return 3;
    }
    const tables = {};
    for (const n of REQUIRED_TABLES) tables[TABLE_KEYS[n]] = byName.get(n);
    console.log(`  ✓ Base 表发现完成（${REQUIRED_TABLES.length} 张标准表齐全）`);

    // 4. 节点身份
    const hostDefault = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-") || "node";
    const node = flags.node || (await ask("节点名（中台里认这个名字）", hostDefault));
    const zone = flags.zone || (await ask("所属区（home / work）", "home"));
    const prefix = flags.prefix || (await ask("能力名前缀（登记为 CAP-<前缀>-<能力>）", node));
    const nodeDesc = flags.desc ?? (await ask("节点一句话说明（可空）", ""));

    // 5. 写配置（已有 node.json 默认不覆盖）
    fs.mkdirSync(configDir, { recursive: true });
    const nodeJsonPath = path.join(configDir, "node.json");
    if (fs.existsSync(nodeJsonPath) && !flags.force) {
      const ow = interactive ? await ask("node.json 已存在，覆盖？(y/N)", "N") : "N";
      if (!/^y/i.test(ow)) { console.error("  ✗ 已保留现有 node.json，未做任何修改（--force 可强制覆盖）。"); return 4; }
    }
    const appEnvPath = path.join(configDir, "app.env");
    fs.writeFileSync(appEnvPath, `APP_ID=${appId}\nAPP_SECRET=${secret}\n`, { mode: 0o600 });
    fs.chmodSync(appEnvPath, 0o600);
    const nodeJson = {
      node, zone, nodeDesc,
      appEnv: appEnvPath,
      baseToken,
      pollSec: 45,
      sweepSec: 900,
      events: false,
      doorbellFile: null,
      capPrefix: prefix,
      tables,
    };
    fs.writeFileSync(nodeJsonPath, JSON.stringify(nodeJson, null, 1) + "\n");
    const cmdPath = path.join(configDir, "commands.json");
    if (!fs.existsSync(cmdPath)) {
      const seed = {
        "echo-test": {
          command: `node ${JSON.stringify(path.join(appDir, "src", "executors", "echo.mjs"))}`,
          desc: "链路自检：回显任务参数",
          mode: "json",
          name: "回声测试",
          side_effect: "read",
        },
      };
      fs.writeFileSync(cmdPath, JSON.stringify(seed, null, 1) + "\n");
      console.log("  ✓ 已写入 app.env（600）、node.json、commands.json（种子能力 echo-test）");
    } else {
      console.log("  ✓ 已写入 app.env（600）、node.json；commands.json 已存在，保留原样");
    }
    console.log("  · events 先关（45 秒轮询）；事件订阅需在该机以用户身份向 Base 注册一次，属可选加速项。");

    // 6. 自检
    const dc = await doctor(configDir, appDir);
    if (dc !== 0) {
      console.error("  ✗ 自检未全过，按上面清单修完后运行 `hub-node doctor` 复查。");
      return dc;
    }

    // 7. 自启（可选）
    let wantService = flags.service;
    if (!wantService && interactive) wantService = /^y/i.test(await ask("现在注册开机自启并启动守护？(Y/n)", "Y"));
    if (wantService) {
      const sc = await service(configDir, {}, appDir);
      if (sc !== 0) { console.error("  ✗ 自启注册失败，看上面输出。"); return sc; }
      console.log("  ✓ 自启已注册、守护已启动。");
    } else {
      console.log("  · 未注册自启；手动运行守护：hub-node daemon");
    }
    console.log(`setup 完成：节点 ${node}（能力前缀 CAP-${prefix}-），枢纽派 echo-test 到 ${node} 即可验收。`);
    return 0;
  } finally {
    rl.close();
  }
}
