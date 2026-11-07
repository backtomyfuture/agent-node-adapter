// setup —— 一键配置向导：把「装节点」的门槛压到一条命令。
// 做完的事：确认 lark-cli 在位（不在则用 npm 装）；复用 lark-cli 已配置的
// 飞书应用（凭据只在本机流转：配置文件 / macOS 钥匙串 / 环境变量 /
// 已有 600 的 app.env -> 本机 app.env，绝不打印明文，也不接受命令行 Secret）；
// 向 Base 自动发现六张表的 ID 并写入 node.json；种子能力只放绝对路径 echo-test；
// 最后跑 doctor 自检，可选顺带注册开机自启。
// 已有 lark-cli 配置是主路径；没有时给出确切的下一步（lark-cli config init）。

import crypto from "node:crypto";
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
  const f = { yes: false, force: false, service: false, role: "node" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--force") f.force = true;
    else if (a === "--service") f.service = true;
    else if (a === "--role") f.role = argv[++i] || "node";
    else if (a.startsWith("--role=")) f.role = a.slice("--role=".length);
    else if (a === "--owner" || a === "--owner-open-id") f.ownerOpenId = argv[++i];
    else if (a.startsWith("--owner=")) f.ownerOpenId = a.slice("--owner=".length);
    else if (a.startsWith("--owner-open-id=")) f.ownerOpenId = a.slice("--owner-open-id=".length);
    else if (a === "--base") f.base = argv[++i];
    else if (a === "--node") f.node = argv[++i];
    else if (a === "--zone") f.zone = argv[++i];
    else if (a === "--prefix") f.prefix = argv[++i];
    else if (a === "--desc") f.desc = argv[++i];
    else if (a === "--app-id") f.appId = argv[++i];
    // 明文参数会留在 ps 和 shell 历史里，只拒绝、不保存值。
    else if (a === "--app-secret" || a.startsWith("--app-secret=")) {
      f.rejectAppSecret = true;
      if (a === "--app-secret") i++;
    }
  }
  return f;
}

function richPath() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")];
  const cur = (process.env.PATH || "").split(path.delimiter);
  return [...new Set([...extra, ...cur])].join(path.delimiter);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, PATH: richPath() }, stdio: ["ignore", "pipe", "ignore"], ...opts });
}

function checkDriveSubscription(baseToken, appId) {
  try {
    const args = [
      "api", "GET", `/open-apis/drive/v1/files/${baseToken}/get_subscribe`,
      "--params", JSON.stringify({ file_type: "bitable" }),
      "--as", "user",
      "--json",
    ];
    const out = run("lark-cli", args);
    const parsed = JSON.parse(out);
    if (parsed?.data?.is_subscribe === true) return { subscribed: true };
    return { subscribed: false, error: parsed?.error?.message || parsed?.msg || (parsed?.data?.is_subscribe === false ? "未订阅" : out.trim()) };
  } catch (e) {
    return { subscribed: false, error: e.message };
  }
}

// 尝试以当前用户身份向 Base 注册云文档事件订阅（ws 秒级门铃所需）
function tryRegisterDriveSubscription(baseToken, appId) {
  const before = checkDriveSubscription(baseToken, appId);
  if (before.subscribed) return { success: true };

  try {
    const out = run("lark-cli", [
      "api", "POST", `/open-apis/drive/v1/files/${baseToken}/subscribe`,
      "--params", JSON.stringify({ file_type: "bitable" }),
      "--as", "user",
      "--json",
    ]);
    const parsed = JSON.parse(out);
    const after = checkDriveSubscription(baseToken, appId);
    if (after.subscribed) return { success: true };
    return { success: false, error: parsed?.error?.message || parsed?.msg || after.error || out.trim() };
  } catch (e) {
    const after = checkDriveSubscription(baseToken, appId);
    if (after.subscribed) return { success: true };
    return { success: false, error: e.message };
  }
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

function parseMasterKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.startsWith("go-keyring-base64:")) {
    try {
      s = Buffer.from(s.slice("go-keyring-base64:".length), "base64").toString("utf8").trim();
    } catch {
      return null;
    }
  }
  try {
    const key = Buffer.from(s, "base64");
    if (key.length === 32) return key;
  } catch {
    return null;
  }
  return null;
}

function loadMasterKey() {
  const fileCandidates = [
    path.join(os.homedir(), "Library", "Application Support", "lark-cli", "master.key.file"),
    path.join(os.homedir(), ".local", "share", "lark-cli", "master.key.file"),
  ];
  for (const fp of fileCandidates) {
    try {
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, "utf8").trim();
        const key = parseMasterKey(content);
        if (key) return key;
      }
    } catch { /* 下一个 */ }
  }

  if (process.platform === "darwin") {
    try {
      const out = run("security", ["find-generic-password", "-s", "lark-cli", "-a", "master.key", "-w"]).trim();
      const key = parseMasterKey(out);
      if (key) return key;
    } catch { /* 忽略 */ }
  }

  return null;
}

function decryptLarkCliSecret(secretId) {
  if (!secretId || typeof secretId !== "string") return null;
  const key = loadMasterKey();
  if (!key) return null;

  const encFileName = secretId.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
  const dirCandidates = [
    path.join(os.homedir(), "Library", "Application Support", "lark-cli"),
    path.join(os.homedir(), ".local", "share", "lark-cli"),
  ];

  for (const dir of dirCandidates) {
    const encPath = path.join(dir, encFileName);
    try {
      if (!fs.existsSync(encPath)) continue;
      const buf = fs.readFileSync(encPath);
      if (buf.length < 12 + 16) continue;
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(buf.length - 16);
      const ciphertext = buf.subarray(12, buf.length - 16);

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      if (decrypted) return decrypted;
    } catch { /* 下一个目录或失败 */ }
  }

  return null;
}

// 从 lark-cli 的应用条目里解析出 secret 明文；只在本机内存里流转，绝不打印。
// 形态：明文字符串 / 新版 lark-cli 安全存储（AES-256-GCM 文件） / 旧版 macOS 钥匙串引用。
function resolveSecret(app) {
  const s = app?.appSecret;
  if (typeof s === "string" && s) return { value: s, source: "lark-cli 配置（明文）" };
  if (s && typeof s === "object") {
    // 优先尝试新版 lark-cli 安全存储解密（AES-256-GCM）
    if (s.id) {
      const dec = decryptLarkCliSecret(s.id);
      if (dec) return { value: dec, source: "lark-cli 安全存储（自动解密）" };
    }
    // 旧版回退：直接通过 security 查明文
    if (s.source === "keychain" && s.id && process.platform === "darwin") {
      for (const args of [["find-generic-password", "-a", s.id, "-w"], ["find-generic-password", "-l", s.id, "-w"], ["find-generic-password", "-s", s.id, "-w"]]) {
        try {
          const out = run("security", args).replace(/\n$/, "");
          if (out) return { value: out, source: "macOS 钥匙串（经 lark-cli 引用）" };
        } catch { /* 换一种查法 */ }
      }
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

// 自动探测和发现多维表格 Base（通过 lark-cli / tempBus 搜索及本机已有配置，并验证标准表）
async function discoverCandidateBases(tempBus) {
  const candidates = [];
  const seen = new Set();

  const add = (token, name, source) => {
    const t = extractBaseToken(token);
    if (!t || seen.has(t)) return;
    seen.add(t);
    candidates.push({ token: t, name: name || t, source });
  };

  const addEntity = (o, source) => {
    if (!o || typeof o !== "object") return;
    if (o.docs_type && o.docs_type !== "bitable") return;
    const tok = o.docs_token || o.token || o.file_token || o.doc_token;
    const name = o.title || o.name;
    add(tok, name, source);
  };

  // 1. 优先使用 tempBus 以 Bot 身份搜索（依次尝试关键词 ['Agent中台', 'Agent', '中台']，一旦找到候选即停）
  if (tempBus && typeof tempBus.api === "function") {
    for (const kw of ["Agent中台", "Agent", "中台"]) {
      try {
        const res = await tempBus.api("POST", "/suite/docs-api/search/object", {
          search_key: kw,
          count: 10,
          docs_types: ["bitable"],
        });
        const objs = res?.docs_entities ?? res?.data?.docs_entities ?? [];
        for (const o of objs) {
          addEntity(o, `tempBus (bot) 搜索 "${kw}"`);
        }
        if (candidates.length > 0) break;
      } catch { /* 忽略错误，继续下一个关键词或后续搜索方式 */ }
    }
  }

  // 2. 若 tempBus 未搜出，尝试 lark-cli 以 bot 身份搜索
  if (candidates.length === 0) {
    for (const kw of ["Agent中台", "Agent", "中台"]) {
      try {
        const out = run("lark-cli", [
          "api", "POST", "/open-apis/suite/docs-api/search/object",
          "--data", JSON.stringify({ search_key: kw, count: 10, docs_types: ["bitable"] }),
          "--as", "bot",
          "--json",
        ]);
        const parsed = JSON.parse(out);
        const objs = parsed?.data?.docs_entities ?? parsed?.docs_entities ?? [];
        for (const o of objs) {
          addEntity(o, `lark-cli bot 搜索 "${kw}"`);
        }
        if (candidates.length > 0) break;
      } catch { /* 忽略错误 */ }
    }
  }

  // 3. 尝试用 lark-cli 搜索 'Agent中台' 或 bitable 类型文件（user 身份）
  if (candidates.length === 0) {
    try {
      const out = run("lark-cli", [
        "drive", "+search",
        "--doc-types", "bitable",
        "--query", "Agent中台",
        "--as", "user",
        "--json",
      ]);
      const parsed = JSON.parse(out);
      const docs = parsed?.docs ?? parsed?.data?.docs ?? parsed?.items ?? [];
      for (const d of docs) {
        addEntity(d, "lark-cli 搜索");
      }
    } catch { /* 忽略错误 */ }
  }

  if (candidates.length === 0) {
    try {
      const out = run("lark-cli", [
        "drive", "+search",
        "--doc-types", "bitable",
        "--page-size", "10",
        "--as", "user",
        "--json",
      ]);
      const parsed = JSON.parse(out);
      const docs = parsed?.docs ?? parsed?.data?.docs ?? parsed?.items ?? [];
      for (const d of docs) {
        addEntity(d, "lark-cli 搜索");
      }
    } catch { /* 忽略错误 */ }
  }

  if (candidates.length === 0) {
    try {
      const out = run("lark-cli", [
        "api", "POST", "/open-apis/suite/docs-api/search/object",
        "--data", JSON.stringify({ search_key: "Agent中台", count: 10, docs_types: ["bitable"] }),
        "--as", "user",
        "--json",
      ]);
      const parsed = JSON.parse(out);
      const objs = parsed?.data?.docs_entities ?? parsed?.docs_entities ?? [];
      for (const o of objs) {
        addEntity(o, "docs-api 搜索");
      }
    } catch { /* 忽略错误 */ }
  }

  // 2. 检查本地已有配置
  const knownConfigPaths = [
    path.join(os.homedir(), ".hub-node", "node.json"),
    path.join(os.homedir(), ".hub-node-hub", "node.json"),
  ];
  for (const p of knownConfigPaths) {
    try {
      if (fs.existsSync(p)) {
        const d = JSON.parse(fs.readFileSync(p, "utf8"));
        const token = d.baseToken;
        if (token && !isPlaceholderToken(token)) {
          add(token, "已有配置", p);
        }
      }
    } catch { /* 忽略错误 */ }
  }

  // 3. 用 tempBus 校验哪些 Base 包含 6 张标准表，并补全名字
  const verified = [];
  for (const c of candidates) {
    try {
      const meta = await tempBus.api("GET", `/bitable/v1/apps/${c.token}`);
      if (meta?.app?.name) c.name = meta.app.name;
      const tablesRes = await tempBus.api("GET", `/bitable/v1/apps/${c.token}/tables?page_size=100`);
      const names = new Set((tablesRes?.items ?? []).map((t) => t.name));
      const hasAll = REQUIRED_TABLES.every((n) => names.has(n));
      c.hasStandardTables = hasAll;
      if (hasAll) verified.push(c);
    } catch {
      // 无法访问该 Base（无权限或不存在），跳过
    }
  }

  return verified.length > 0 ? verified : candidates;
}

// install.sh 曾经把 example 直接种成 node.json。这些值仍是占位符时，
// 首装还没完成：--yes 应覆盖而不是退出 4，交互默认 Y。
// app_token 是旧示例字段（正式配置用 baseToken），出现 REPLACE 或 bascn 即占位。
// baseToken / 表 ID 认本仓库 example 的尖括号、<REPLACE>，以及 bascnxxxx 这种填充。
function isPlaceholderToken(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  if (s.startsWith("<") || s.includes("REPLACE")) return true;
  return s === "bascn" || /^bascn[xX._-]+$/.test(s);
}

function isUnfinishedExample(raw) {
  if (!raw || typeof raw !== "object") return false;
  const appToken = raw.app_token ?? raw.appToken;
  if (typeof appToken === "string" && (appToken.includes("REPLACE") || appToken.includes("bascn"))) return true;
  const fields = [raw.baseToken];
  if (raw.tables && typeof raw.tables === "object") fields.push(...Object.values(raw.tables));
  return fields.some(isPlaceholderToken);
}

// 只认安装脚本种下的那份示例：相对路径 echo 指错，lan-exec 又会让 doctor 因 carrier 离线失败。
// 用户事后自己写的能力表不在这里替换。
function isExampleCommands(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (Object.hasOwn(obj, "lan-exec")) return true;
  return Object.values(obj).some((e) => typeof e?.command === "string" && e.command.includes("../src/executors/echo.mjs"));
}

function echoSeed(appDir) {
  return {
    "echo-test": {
      command: `node ${JSON.stringify(path.join(appDir, "src", "executors", "echo.mjs"))}`,
      desc: "链路自检：回显任务参数",
      mode: "json",
      name: "回声测试",
      side_effect: "read",
    },
  };
}

function envSecret() {
  const hub = (process.env.HUB_APP_SECRET || "").trim();
  if (hub) return { value: hub, source: "环境变量 HUB_APP_SECRET" };
  const app = (process.env.APP_SECRET || "").trim();
  if (app) return { value: app, source: "环境变量 APP_SECRET" };
  return null;
}

// 只读权限刚好是 600 的普通文件。更松的权限或符号链接一律不读，避免把 Secret 从暴露的文件载入内存。
function readLockedAppEnv(configDir) {
  const p = path.join(configDir, "app.env");
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) return { insecure: true };
  const kv = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { appId: kv.APP_ID || "", secret: kv.APP_SECRET || "" };
}

// Node 26 的 promises readline 不再暴露 _writeToOutput，提问期间改写 stdout.write
// 把按键回显丢掉，只放行换行；finally 恢复，避免 Secret 留在屏幕或后续输出上。
async function askHidden(rl, prompt) {
  process.stdout.write(prompt.endsWith(" ") ? prompt : prompt + " ");
  const original = process.stdout.write;
  process.stdout.write = function (chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (/[\r\n]/.test(s)) return original.call(this, "\n", typeof cb === "function" ? cb : undefined);
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    const raw = await rl.question("");
    const answer = String(raw || "").trim();
    try {
      if (Array.isArray(rl.history)) rl.history = rl.history.filter((h) => String(h).trim() !== answer);
      if ("historyIndex" in rl) rl.historyIndex = -1;
    } catch { /* 清不掉历史也不能把 Secret 打进日志 */ }
    return answer;
  } finally {
    process.stdout.write = original;
  }
}

export async function runSetup(configDir, argv, appDir) {
  const flags = parseFlags(argv);
  const role = flags.role || "node";
  if (role !== "node" && role !== "hub") {
    console.error(`  ✗ --role 只能是 node 或 hub，收到：${role}`);
    return 2;
  }
  if (flags.rejectAppSecret) {
    console.error("  ✗ 已移除 --app-secret（会进入进程列表和 shell 历史）。请改用环境变量 APP_SECRET 或 HUB_APP_SECRET，或权限为 600 的 app.env。");
    return 2;
  }
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
    console.log(`hub-node setup —— 一键配置${role === "hub" ? "枢纽（hub）" : "节点（node）"}`);
    console.log(`role: ${role}`);
    console.log(`config dir: ${configDir}`);

    // 1. 优先检测本机是否安装了 lark-cli：若已安装则复用已配置的飞书应用；
    //    未安装且无环境变量/app.env 凭据时，引导安装 lark-cli。
    const lv = larkVersion();
    let larkCfg = null;
    if (lv) {
      console.log(`  ✓ lark-cli 已安装（${lv}）`);
      larkCfg = readLarkConfig();
      if (larkCfg) console.log(`  ✓ 读到 lark-cli 配置：${larkCfg.path}（${larkCfg.apps.length} 个应用）`);
    }

    const fromEnv = envSecret();
    const fileCreds = readLockedAppEnv(configDir);
    let appId = flags.appId || null;
    let secret = fromEnv?.value || null;
    let secretSource = fromEnv?.source || null;
    if (!secret && fileCreds?.secret) { secret = fileCreds.secret; secretSource = "本机 app.env（600）"; }
    if (!appId && fileCreds?.appId) appId = fileCreds.appId;

    if (!(appId && secret)) {
      if (!lv) {
        if (!ensureLarkCli()) return 2;
        larkCfg = readLarkConfig();
        if (larkCfg) console.log(`  ✓ 读到 lark-cli 配置：${larkCfg.path}（${larkCfg.apps.length} 个应用）`);
      }
      if (!larkCfg && !appId) {
        if (interactive) {
          console.log("  · lark-cli 尚未配置应用，正在启动 lark-cli config init 引导配置…");
          try {
            execSync("lark-cli config init", { stdio: "inherit", env: { ...process.env, PATH: richPath() } });
            larkCfg = readLarkConfig();
            if (larkCfg) console.log(`  ✓ 读到 lark-cli 配置：${larkCfg.path}（${larkCfg.apps.length} 个应用）`);
          } catch (e) {
            console.error("  ✗ lark-cli 配置引导未完成：" + e.message);
            return 2;
          }
        }
        if (!larkCfg && !appId) {
          console.error("  ✗ lark-cli 还没有配置任何飞书应用。");
          console.error("    先运行 `lark-cli config init` 按它的引导完成应用配置，再重跑 `hub-node setup`。");
          return 2;
        }
      }
    }

    // 2. 选定应用并解析凭据
    let appEntry = null;
    if (larkCfg) {
      if (appId) appEntry = larkCfg.apps.find((a) => a.appId === appId) || null;
      else if (larkCfg.apps.length === 1) appEntry = larkCfg.apps[0];
      else {
        larkCfg.apps.forEach((a, i) => console.log(`    ${i + 1}. ${a.appId}${a.users?.[0]?.userName ? `（${a.users[0].userName}）` : ""}`));
        const pick = await ask(`选择用作${role === "hub" ? "枢纽" : "节点"}身份的应用序号`, "1");
        appEntry = larkCfg.apps[Number(pick) - 1] || larkCfg.apps[0];
      }
      if (appEntry) appId = appEntry.appId;
    }
    if (!appId) throw new Error("未能确定应用：请用 --app-id 指定，或先完成 lark-cli 配置。");
    if (!secret && appEntry) {
      const r = resolveSecret(appEntry);
      if (r) { secret = r.value; secretSource = r.source; }
    }
    if (!secret && fileCreds?.insecure && !interactive) {
      console.error("  ✗ app.env 存在但权限不是 600（或是符号链接），已拒绝读取。请 chmod 600 后重跑，或改用环境变量 APP_SECRET / HUB_APP_SECRET。");
      return 2;
    }
    if (!secret) {
      if (!interactive) {
        console.error("  ✗ 非交互模式需要环境变量 APP_SECRET 或 HUB_APP_SECRET，或权限为 600 的 app.env。");
        return 2;
      }
      secret = await askHidden(rl, `粘贴应用 ${appId} 的 App Secret（只写入本机 app.env，权限 600，输入不回显）`);
      secretSource = "手工粘贴";
      if (!secret) { console.error("  ✗ 没有 Secret 无法继续。"); return 2; }
    }
    console.log(`  ✓ 应用 ${appId}，凭据来源：${secretSource}`);

    // 3. Base 与表发现
    let defaultBase = null;
    let defaultBaseLabel = "";
    if (!flags.base) {
      const tempBus = new FeishuBus({ appId, appSecret: secret, baseToken: "", tables: {} });
      const candidates = await discoverCandidateBases(tempBus);
      if (candidates.length === 1) {
        defaultBase = candidates[0].token;
        defaultBaseLabel = candidates[0].name ? `${candidates[0].name}（${candidates[0].token}）` : candidates[0].token;
        console.log(`  ✓ 自动发现多维表格 Base：${defaultBaseLabel}`);
      } else if (candidates.length > 1) {
        console.log("  · 发现多个候选多维表格 Base：");
        candidates.forEach((c, idx) => {
          console.log(`    ${idx + 1}. ${c.name} (${c.token})${c.hasStandardTables ? " [含6张标准表]" : ""}`);
        });
        if (interactive) {
          const pick = await ask("选择要使用的 Base 序号或直接粘贴链接", "1");
          const num = Number(pick);
          if (Number.isInteger(num) && num >= 1 && num <= candidates.length) {
            defaultBase = candidates[num - 1].token;
            defaultBaseLabel = candidates[num - 1].name ? `${candidates[num - 1].name}（${candidates[num - 1].token}）` : candidates[num - 1].token;
          } else {
            defaultBase = extractBaseToken(pick) || pick;
          }
        } else {
          defaultBase = candidates[0].token;
        }
      }
    }

    const basePrompt = defaultBaseLabel
      ? "确认或修改多维表格 Base 链接/token"
      : "把多维表格 Base 的链接粘贴进来（打开 Base 页面复制网址即可，或直接给 token）";
    const baseInput = flags.base || (await ask(basePrompt, defaultBase || undefined));
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

    // 4. 身份与参数配置
    let node, zone, prefix, nodeDesc, ownerOpenId;
    if (role === "hub") {
      node = flags.node || "hub";
      ownerOpenId = flags.ownerOpenId || (process.env.HUB_OWNER_OPEN_ID || "").trim();
      const defaultOwner = appEntry?.users?.[0]?.openId || "";
      if (!ownerOpenId) {
        if (interactive) {
          ownerOpenId = await ask(
            "输入机主 open_id（例如 ou_xxxx，审批卡只发给此人且回调只认此人）",
            defaultOwner || undefined
          );
        } else if (defaultOwner) {
          ownerOpenId = defaultOwner;
        } else {
          throw new Error("非交互模式配置 hub 角色缺少机主 open_id：请用 --owner 提供，或设置环境变量 HUB_OWNER_OPEN_ID");
        }
      }
      if (!ownerOpenId) {
        console.error("  ✗ hub 角色必须配置机主 open_id，未配置时审批回调一律拒绝。");
        return 2;
      }
      if (interactive) {
        console.log(`  · 即将配置：枢纽 ${node}（机主 ${ownerOpenId.slice(0, 8)}…），应用 ${appId}，Base ${baseToken.slice(0, 8)}…`);
        const go = await ask("开始配置？(Y/n)", "Y");
        if (!/^y/i.test(go)) { console.error("  已取消，未写任何文件。"); return 5; }
      }
    } else {
      const hostDefault = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-") || "node";
      node = flags.node || (await ask("给这台机器起个节点名（中台按这个名字派活）", hostDefault));
      zone = flags.zone || null;
      if (!zone) {
        if (!interactive) zone = "home";
        else {
          const z = await ask("这台机器主要在哪用？输 1=家里，2=公司", "1");
          zone = (z === "2" || /work/i.test(z)) ? "work" : "home";
        }
      }
      prefix = flags.prefix || node.split("-").filter(Boolean).pop() || node;
      nodeDesc = flags.desc ?? "";
      if (interactive) {
        console.log(`  · 即将配置：节点 ${node}（${zone === "work" ? "公司" : "家里"}），能力前缀 CAP-${prefix}-，应用 ${appId}，Base ${baseToken.slice(0, 8)}…`);
        const go = await ask("开始配置？(Y/n)", "Y");
        if (!/^y/i.test(go)) { console.error("  已取消，未写任何文件。"); return 5; }
      }
    }

    // 5. 写配置。真实 node.json 默认不覆盖；仍是示例占位符则视为首装未完成。
    fs.mkdirSync(configDir, { recursive: true });
    const nodeJsonPath = path.join(configDir, "node.json");
    const nodeExisted = fs.existsSync(nodeJsonPath);
    let placeholder = false;
    if (nodeExisted) {
      try { placeholder = isUnfinishedExample(JSON.parse(fs.readFileSync(nodeJsonPath, "utf8"))); }
      catch { /* 解析不了就按已有配置保护 */ }
    }
    if (nodeExisted && !flags.force) {
      if (placeholder) {
        if (interactive) {
          const ow = await ask("node.json 仍是示例占位符，覆盖并完成首装？(Y/n)", "Y");
          if (!/^y/i.test(ow)) { console.error("  ✗ 已保留现有 node.json，未做任何修改（--force 可强制覆盖）。"); return 4; }
        } else {
          console.log("  · 现有 node.json 仍是示例占位符，视为首装未完成，将覆盖");
        }
      } else {
        const ow = interactive ? await ask("node.json 已存在，覆盖？(y/N)", "N") : "N";
        if (!/^y/i.test(ow)) { console.error("  ✗ 已保留现有 node.json，未做任何修改（--force 可强制覆盖）。"); return 4; }
      }
    }
    const appEnvPath = path.join(configDir, "app.env");
    fs.writeFileSync(appEnvPath, `APP_ID=${appId}\nAPP_SECRET=${secret}\n`, { mode: 0o600 });
    fs.chmodSync(appEnvPath, 0o600);
    const nodeJson = role === "hub" ? {
      node,
      role: "hub",
      ownerOpenId,
      appEnv: appEnvPath,
      baseToken,
      sweepSec: 900,
      events: true,
      tables,
    } : {
      node,
      role: "node",
      zone,
      nodeDesc,
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

    if (role === "node") {
      const cmdPath = path.join(configDir, "commands.json");
      const cmdExisted = fs.existsSync(cmdPath);
      let exampleCmds = false;
      if (cmdExisted) {
        try { exampleCmds = isExampleCommands(JSON.parse(fs.readFileSync(cmdPath, "utf8"))); } catch { /* 留着，下面不覆盖 */ }
      }
      // 缺文件，或这次是在收尾首装（原来没有正式 node.json）且能力表仍是示例。
      const replaceCmds = !cmdExisted || (exampleCmds && (!nodeExisted || placeholder));
      if (replaceCmds) {
        fs.writeFileSync(cmdPath, JSON.stringify(echoSeed(appDir), null, 1) + "\n");
        console.log(cmdExisted
          ? "  ✓ 已写入 app.env（600）、node.json；示例 commands.json（相对路径 echo / lan-exec）已换成绝对路径 echo-test"
          : "  ✓ 已写入 app.env（600）、node.json、commands.json（种子能力 echo-test，绝对路径）");
      } else {
        console.log("  ✓ 已写入 app.env（600）、node.json；commands.json 已存在，保留原样");
      }
    } else {
      console.log("  ✓ 已写入 app.env（600）、node.json（hub 角色不需要 commands.json）");
    }

    // 尝试向 Base 注册云文档事件订阅
    const subRes = tryRegisterDriveSubscription(baseToken, appId);
    if (subRes.success) {
      console.log("  ✓ 云文档事件订阅已成功注册到 Base（长连接秒级唤醒已就绪）");
      if (role === "node") {
        nodeJson.events = true;
        fs.writeFileSync(nodeJsonPath, JSON.stringify(nodeJson, null, 1) + "\n");
      }
    } else {
      if (role === "hub") {
        console.log(`  · 云文档事件订阅未自动完成（${subRes.error ? subRes.error.slice(0, 100) : "需用户登录"}）`);
        console.log("    hub 角色强制使用长连接（用于审批卡回调与事件唤醒）。若要接收表变更秒级门铃，请在本机终端执行以下一次性步骤：");
        console.log("    1. lark-cli auth login --scope docs:event:subscribe");
        console.log(`    2. lark-cli api POST /open-apis/drive/v1/files/${baseToken}/subscribe --params '{"file_type":"bitable"}' --as user`);
        console.log("    （未完成订阅时，hub 仍可通过长连接接收审批卡回调与 15 分钟定时扫表）");
      } else {
        console.log("  · events 先关（45 秒轮询）；事件订阅需在该机以用户身份向 Base 注册一次，属可选加速项。");
        console.log("    若需升级为 ws 秒级唤醒，可随时在本机终端执行以下一次性步骤：");
        console.log("    1. lark-cli auth login --scope docs:event:subscribe");
        console.log(`    2. lark-cli api POST /open-apis/drive/v1/files/${baseToken}/subscribe --params '{"file_type":"bitable"}' --as user`);
        console.log(`    3. 将 ${nodeJsonPath} 中的 "events" 改为 true`);
      }
    }

    // 6. 自检
    let dc = await doctor(configDir, appDir, { role });
    if (role === "hub") {
      try {
        const { hubDoctor } = await import("./hub/index.mjs");
        const extra = await hubDoctor(configDir);
        if (extra) dc = 1;
      } catch (e) {
        console.error("  ✗ hub 自检模块加载失败：" + e.message);
        dc = 1;
      }
    }
    if (dc !== 0) {
      console.error(`  ✗ 自检未全过，按上面清单修完后运行 \`hub-node doctor${role === "hub" ? " --role hub" : ""}\` 复查。`);
      return dc;
    }

    // 7. 自启（可选）
    let wantService = flags.service;
    if (!wantService && interactive) wantService = /^y/i.test(await ask("现在注册开机自启并启动守护？(Y/n)", "Y"));
    if (wantService) {
      const sc = await service(configDir, { role }, appDir);
      if (sc !== 0) { console.error("  ✗ 自启注册失败，看上面输出。"); return sc; }
      console.log("  ✓ 自启已注册、守护已启动。");
    } else {
      console.log(`  · 未注册自启；手动运行守护：hub-node daemon${role === "hub" ? " --role hub" : ""} --config ${configDir}`);
    }
    if (role === "hub") {
      console.log(`setup 完成：枢纽 hub 就绪（机主已绑定），可通过 hub-node daemon --role hub 常驻。`);
    } else {
      console.log(`setup 完成：节点 ${node}（能力前缀 CAP-${prefix}-），枢纽派 echo-test 到 ${node} 即可验收。`);
    }
    return 0;
  } finally {
    rl.close();
  }
}
