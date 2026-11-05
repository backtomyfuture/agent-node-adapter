// 节点内核：单进程守护，只做协议——认领 / 心跳 / 拼 prompt / 拉起本机命令 / 解析回执 / 回写。
// 「能干什么活」由节点本地配置 commands.json 决定（skill -> 命令模板），
// 新增能力 = 改配置 + 启动时自动登记能力名片，不改本文件。
// 参考实现：同项目的 Python 守护进程 worker-4.1（已退役），本文件为其 Node 移植。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuBus, f1 } from "./bus/feishu.mjs";
import { FeishuEventReceiver } from "./bus/feishu-events.mjs";
import { execViaCarrier, pingCarrier } from "./carrier.mjs";

export const DAEMON_VERSION = "node-0.4.0";
const HOP_LIMIT = 8;
const MAX_RETRIES = 2;
const STALE_MIN = 20;

class NeedInput extends Error {}

function log(msg) {
  console.log(new Date().toISOString().slice(0, 19), msg);
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}`;
}

const nowShort = () => nowStr().slice(0, 16).replace("T", " ");

function readEnvFile(p) {
  const kv = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

export function loadConfig(configDir) {
  const cfgPath = path.join(configDir, "node.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  let { appId, appSecret } = cfg;
  if ((!appId || !appSecret) && cfg.appEnv) {
    const kv = readEnvFile(cfg.appEnv.replace(/^~/, os.homedir()));
    appId = appId || kv.APP_ID;
    appSecret = appSecret || kv.APP_SECRET;
  }
  if (!appId || !appSecret) throw new Error("no app credentials: set appId/appSecret or appEnv in node.json");
  if (!cfg.node) throw new Error("node.json missing 'node'");
  if (!cfg.baseToken || !cfg.tables) throw new Error("node.json missing baseToken/tables");
  return {
    node: cfg.node,
    zone: cfg.zone ?? "",
    nodeDesc: cfg.nodeDesc ?? "",
    pollSec: cfg.pollSec ?? 45,
    sweepSec: cfg.sweepSec ?? 900,
    events: cfg.events !== false,
    doorbellFile: cfg.doorbellFile ? cfg.doorbellFile.replace(/^~/, os.homedir()) : null,
    carrierSocket: cfg.carrierSocket ? cfg.carrierSocket.replace(/^~/, os.homedir()) : path.join(configDir, "carrier.sock"),
    capPrefix: cfg.capPrefix ?? cfg.node,
    bus: new FeishuBus({ appId, appSecret, baseToken: cfg.baseToken, tables: cfg.tables }),
    configDir,
  };
}

export class Kernel {
  constructor(cfg) {
    this.cfg = cfg;
    this.bus = cfg.bus;
    this.T = cfg.bus.tables;
    this.commands = {};
    this._wakeFlag = false;
    this._wsUp = false;
    this.loadCommands();
  }

  loadCommands() {
    try {
      this.commands = JSON.parse(fs.readFileSync(path.join(this.cfg.configDir, "commands.json"), "utf8"));
    } catch (e) {
      log("commands.json load failed: " + e.message);
      this.commands = {};
    }
  }

  // ---------- 消息与产物（沟通只追加；正文由 Parts 承载） ----------

  async listMessages(taskId) {
    return (await this.bus.listRecords(this.T.messages)).filter((m) => f1(m, "Task_ID") === taskId);
  }

  async listParts(parentId) {
    const ps = (await this.bus.listRecords(this.T.parts)).filter((p) => f1(p, "Parent_ID") === parentId);
    return ps.sort((a, b) => (Number(f1(a, "Seq")) || 0) - (Number(f1(b, "Seq")) || 0));
  }

  async msgText(msg) {
    const parts = await this.listParts(f1(msg, "Msg_ID"));
    return parts.filter((p) => f1(p, "Kind") === "text").map((p) => f1(p, "Text")).join("\n");
  }

  async msgData(msg) {
    const out = {};
    for (const p of await this.listParts(f1(msg, "Msg_ID"))) {
      if (f1(p, "Kind") === "data" && f1(p, "Data")) {
        try { Object.assign(out, JSON.parse(f1(p, "Data"))); } catch { /* 坏数据跳过 */ }
      }
    }
    return out;
  }

  // 任务参数 = 首条 instruction 消息的 DataPart 合并（Tasks 表不存参数）。
  async getParams(task) {
    for (const m of await this.listMessages(f1(task, "Task_ID"))) {
      if (f1(m, "Kind") === "instruction") return this.msgData(m);
    }
    return {};
  }

  async createPart(parentId, parentType, seq, kind, { text = "", fileUri = "", fileName = "", mime = "", data = "" } = {}) {
    await this.bus.createRecord(this.T.parts, {
      Part_ID: `${parentId}-P${seq}`, Parent_ID: parentId, Parent_Type: parentType,
      Seq: seq, Kind: kind, Text: text, File_URI: fileUri, File_Name: fileName,
      Mime_Type: mime, Data: data,
    });
  }

  async writeMessage(task, kind, content, { role = "agent", toNode = "hub", inReplyTo = "", artifactRef = "", data = null } = {}) {
    const taskId = f1(task, "Task_ID");
    const seq = (await this.listMessages(taskId)).length + 1;
    const msgId = `MSG-${taskId.replace("TASK-", "")}-${String(seq).padStart(2, "0")}`;
    await this.bus.createRecord(this.T.messages, {
      Msg_ID: msgId, Task_ID: taskId, Context_ID: f1(task, "Context_ID"),
      From_Node: this.cfg.node, To_Node: toNode, Role: role, Kind: kind,
      Artifact_Ref: artifactRef, In_Reply_To: inReplyTo, Created_At: nowShort(),
    });
    let seqNo = 0;
    if (content) await this.createPart(msgId, "message", ++seqNo, "text", { text: content.slice(0, 4000) });
    if (data) await this.createPart(msgId, "message", ++seqNo, "data", { data: JSON.stringify(data) });
    return msgId;
  }

  async registerArtifact(task, res) {
    const pointer = String(res.artifact ?? "");
    if (!pointer) return "";
    const taskId = f1(task, "Task_ID");
    const arts = (await this.bus.listRecords(this.T.artifacts)).filter((a) => f1(a, "Task_ID") === taskId);
    const name = String(res.artifact_name || f1(task, "Skill_ID") || "result");
    const artId = `${taskId}-A${arts.length + 1}`;
    await this.bus.createRecord(this.T.artifacts, {
      Artifact_ID: artId, Task_ID: taskId, Context_ID: f1(task, "Context_ID"),
      Name: name, Description: String(res.summary ?? "").slice(0, 500),
      Is_Final: "Yes", Created_By: this.cfg.node, Created_At: nowShort(),
    });
    await this.createPart(artId, "artifact", 1, "file", { fileUri: pointer, fileName: name });
    return artId;
  }

  async writeRun(task, outcome, started, error = "") {
    const taskId = f1(task, "Task_ID");
    const runs = (await this.bus.listRecords(this.T.runs)).filter((r) => f1(r, "Task_Ref") === taskId);
    const runId = `${taskId}-R${runs.length + 1}`;
    await this.bus.createRecord(this.T.runs, {
      Run_ID: runId, Task_Ref: taskId, Node: this.cfg.node,
      Worker: f1(task, "Worker_Hint") || "daemon", Outcome: outcome,
      Error_Log: error, Started_At: started, Finished_At: nowStr(),
    });
    return runId;
  }

  // ---------- 执行：命令模板两种模式 ----------

  async instructionText(task) {
    const texts = [];
    for (const m of await this.listMessages(f1(task, "Task_ID"))) {
      if (f1(m, "Kind") === "instruction") {
        const t = await this.msgText(m);
        if (t) texts.push(t);
      }
    }
    return texts.join("\n");
  }

  async buildPrompt(task, params, extraAnswers) {
    const lines = [
      `你是中台节点 ${this.cfg.node} 的执行 agent，正在处理一个来自多 Agent 中台的任务。`,
      `任务编号：${f1(task, "Task_ID")}`,
      `任务标题：${f1(task, "Title")}`,
      "任务指令：",
      (await this.instructionText(task)) || "(无文字指令，见参数)",
      `任务参数（JSON）：${JSON.stringify(params)}`,
    ];
    if (extraAnswers?.length) lines.push(`机主对你先前问题的答复：${extraAnswers.join("；")}`);
    lines.push(
      "",
      "回执约定（必须遵守）：",
      "1. 完成后用一段话汇报结果：做了什么、关键数据、异常项。",
      "2. 如有产物文件，单独一行写：ARTIFACT: <路径或URL>，可再跟一行 ARTIFACT_NAME: <名称>。",
      "3. 如信息不足必须提问，输出一个 ```agent-ask 代码块、块内写清问题，然后停止，不要猜测执行。",
      "4. 不要输出与任务无关的内容。",
    );
    return lines.join("\n");
  }

  // 执行分流（executor × context）：默认 direct 在本进程直跑；
  // 条目标了 context: "carrier" 时经本地 socket 交给用户终端里的 carrier
  // 代跑（设计 §9），执行语义与直跑一致，只是换了进程语境。
  async execFor(entry, command, stdinText, timeoutSec, cwd) {
    if (entry?.context === "carrier") {
      return execViaCarrier(this.cfg.carrierSocket, {
        command, cwd, input: stdinText, timeoutSec,
      });
    }
    return this.runShell(command, stdinText, timeoutSec, cwd);
  }

  runShell(command, stdinText, timeoutSec, cwd) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      const extra = ["/opt/homebrew/bin", path.join(os.homedir(), ".local/bin"), "/usr/local/bin"];
      env.PATH = [...extra, env.PATH ?? "/usr/bin:/bin"].join(":");
      const p = spawn(command, {
        shell: true, cwd: cwd || os.homedir(), env,
        timeout: timeoutSec * 1000,
      });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code, signal) => resolve({ code, signal, stdout: out, stderr: err }));
      if (stdinText != null) p.stdin.write(stdinText);
      p.stdin.end();
    });
  }

  parseAgentOutput(out) {
    const ask = out.match(/```agent-ask\s*([\s\S]*?)```/);
    if (ask) throw new NeedInput(ask[1].trim());
    let artifact = "", artName = "";
    const keep = [];
    for (const line of out.split("\n")) {
      if (line.startsWith("ARTIFACT:")) artifact = line.slice("ARTIFACT:".length).trim();
      else if (line.startsWith("ARTIFACT_NAME:")) artName = line.slice("ARTIFACT_NAME:".length).trim();
      else keep.push(line);
    }
    const summary = keep.join("\n").trim();
    if (!summary) throw new Error("agent produced no output");
    const r = { summary: summary.slice(0, 4000), artifact };
    if (artName) r.artifact_name = artName;
    return r;
  }

  async runCommand(skill, task, params, extraAnswers) {
    const entry = this.commands[skill] ?? {};
    const command = entry.command ?? "";
    if (!command) throw new Error("no command template configured for skill: " + skill);
    const timeout = Number(params.timeout_sec || entry.timeout_sec || 600);
    // 执行工作目录默认取节点配置目录（节点的主场，执行器脚本多按相对路径组织）。
    const cwd = entry.cwd || this.cfg.configDir;
    if ((entry.mode ?? "agent") === "json") {
      const envelope = { ...params, _hub: {
        task_id: f1(task, "Task_ID"), title: f1(task, "Title"),
        skill, instruction: await this.instructionText(task),
      } };
      const p = await this.execFor(entry, command, JSON.stringify(envelope), timeout, cwd);
      if (p.code !== 0) throw new Error(`command exit ${p.code}: ${(p.stderr || p.stdout).slice(0, 500)}`);
      const lines = (p.stdout ?? "").trim().split("\n").filter(Boolean);
      if (!lines.length) throw new Error("command produced no output");
      const res = JSON.parse(lines[lines.length - 1]);
      if (res.need_input) throw new NeedInput(String(res.need_input));
      const r = { summary: String(res.summary ?? "").slice(0, 4000), artifact: String(res.artifact ?? "") };
      if (res.artifact_name) r.artifact_name = String(res.artifact_name);
      return r;
    }
    const prompt = await this.buildPrompt(task, params, extraAnswers);
    let p;
    if (command.includes("{prompt}")) {
      const quoted = "'" + prompt.replaceAll("'", "'\\''") + "'";
      p = await this.execFor(entry, command.replace("{prompt}", quoted), null, timeout, cwd);
    } else {
      p = await this.runShell(command, prompt, timeout, cwd);
    }
    if (p.code !== 0) throw new Error(`agent exit ${p.code}: ${(p.stderr || p.stdout).slice(0, 500)}`);
    return this.parseAgentOutput((p.stdout ?? "").trim());
  }

  // ---------- 能力登记 ----------

  async ensureCapabilities() {
    const rows = await this.bus.listRecords(this.T.agentCards);
    const have = new Set(rows.map((r) => f1(r, "Cap_ID")));
    const receiveMode = this.cfg.events || this.cfg.doorbellFile ? "event" : "poll";
    for (const r of rows) {
      if (f1(r, "Node") === this.cfg.node &&
          (f1(r, "Receive_Mode") !== receiveMode || f1(r, "Daemon_Version") !== DAEMON_VERSION)) {
        const upd = { Receive_Mode: receiveMode, Daemon_Version: DAEMON_VERSION };
        if (this.cfg.nodeDesc && !f1(r, "Node_Desc")) upd.Node_Desc = this.cfg.nodeDesc;
        await this.bus.updateRecord(this.T.agentCards, r.record_id, upd);
      }
    }
    const carrierUp = await pingCarrier(this.cfg.carrierSocket);
    this._carrierUp = carrierUp;
    for (const [skill, entry] of Object.entries(this.commands)) {
      const capId = entry.cap_id || `CAP-${this.cfg.capPrefix}-${skill}`;
      if (have.has(capId)) continue;
      await this.bus.createRecord(this.T.agentCards, {
        Cap_ID: capId, Node: this.cfg.node, Zone: this.cfg.zone,
        Skill_Name: entry.name ?? skill, Description: entry.desc ?? "",
        Skill_ID: skill, Side_Effect: entry.side_effect ?? "write",
        Availability: entry.context === "carrier" && !carrierUp ? "offline" : "online", Dispatchable: "Yes",
        Daemon_Version: DAEMON_VERSION, Receive_Mode: receiveMode,
        Node_Desc: this.cfg.nodeDesc,
        Cap_Push: "No", Cap_Streaming: "No", Cap_State_History: "Yes",
      });
      log("registered capability " + capId);
    }
  }

  // carrier 型能力的 Availability 跟随探活结果（设计 §9 铁律：离线标注，不静默降级）。
  async syncCarrierAvailability() {
    const carrierCaps = Object.entries(this.commands)
      .filter(([, e]) => e.context === "carrier")
      .map(([skill, e]) => e.cap_id || `CAP-${this.cfg.capPrefix}-${skill}`);
    if (!carrierCaps.length) return;
    const up = await pingCarrier(this.cfg.carrierSocket);
    if (this._carrierUp === up) return;
    this._carrierUp = up;
    const rows = await this.bus.listRecords(this.T.agentCards);
    for (const capId of carrierCaps) {
      const row = rows.find((r) => f1(r, "Cap_ID") === capId);
      if (row && f1(row, "Availability") !== (up ? "online" : "offline")) {
        await this.bus.updateRecord(this.T.agentCards, row.record_id, {
          Availability: up ? "online" : "offline",
        });
        log(`carrier ${up ? "online" : "offline"}: ${capId} availability updated`);
      }
    }
  }

  async myCapabilities() {
    const skills = new Set();
    for (const r of await this.bus.listRecords(this.T.agentCards)) {
      if (f1(r, "Node") === this.cfg.node && f1(r, "Dispatchable") === "Yes") {
        const s = f1(r, "Skill_ID");
        if (s) skills.add(s);
      }
    }
    return skills;
  }

  // ---------- 任务生命周期 ----------

  async reclaimStale() {
    for (const t of await this.bus.listRecords(this.T.tasks)) {
      if (f1(t, "Status") === "working" && f1(t, "Claimed_By") === this.cfg.node) {
        const hb = f1(t, "Heartbeat_At");
        let stale = true;
        if (hb) {
          const ts = Date.parse(hb.slice(0, 19));
          if (!Number.isNaN(ts)) stale = Date.now() - ts > STALE_MIN * 60_000;
        }
        if (stale) {
          await this.bus.updateRecord(this.T.tasks, t.record_id, {
            Status: "submitted", Claimed_By: "", Heartbeat_At: "",
            Retry_Count: (Number(f1(t, "Retry_Count")) || 0) + 1,
          });
          log("reclaimed stale working task " + f1(t, "Task_ID"));
        }
      }
    }
  }

  async authApproved(task) {
    for (const m of await this.listMessages(f1(task, "Task_ID"))) {
      if (f1(m, "Kind") === "auth_decision") {
        if ((await this.msgData(m)).decision === "approve") return true;
        if ((await this.msgText(m)).includes("approved")) return true;
      }
    }
    return false;
  }

  async askApproval(task) {
    const msgs = await this.listMessages(f1(task, "Task_ID"));
    if (msgs.some((m) => f1(m, "Kind") === "auth_request")) return;
    const mid = await this.writeMessage(task, "auth_request",
      `此任务为 approve 类，执行前需机主批准。任务：${f1(task, "Title")}`);
    await this.bus.updateRecord(this.T.tasks, task.record_id, { Status: "auth-required", Status_Msg: mid });
    log("auth-required " + f1(task, "Task_ID"));
  }

  async execute(task, extraAnswers = null) {
    const taskId = f1(task, "Task_ID");
    const skill = f1(task, "Skill_ID");
    await this.bus.updateRecord(this.T.tasks, task.record_id, {
      Status: "working", Claimed_By: this.cfg.node, Heartbeat_At: nowStr(),
    });
    const check = (await this.bus.listRecords(this.T.tasks)).find((r) => r.record_id === task.record_id);
    if (!check || f1(check, "Claimed_By") !== this.cfg.node || f1(check, "Status") !== "working") {
      log("claim lost " + taskId);
      return;
    }
    log("claimed " + taskId);
    const params = await this.getParams(task);
    if (extraAnswers) params._answers = extraAnswers;
    const hbTimer = setInterval(() => {
      this.bus.updateRecord(this.T.tasks, task.record_id, { Heartbeat_At: nowStr() })
        .catch((e) => log("heartbeat failed: " + e.message));
    }, 60_000);
    const started = nowStr();
    try {
      const res = await this.runCommand(skill, task, params, extraAnswers);
      const artId = await this.registerArtifact(task, res);
      const rid = await this.writeRun(task, "succeeded", started);
      await this.writeMessage(task, "result", res.summary, { artifactRef: artId });
      await this.bus.updateRecord(this.T.tasks, task.record_id, {
        Status: "completed", Latest_Run: rid, Heartbeat_At: "", Status_Msg: "",
      });
      log(`completed ${taskId} -> ${rid}`);
    } catch (e) {
      if (e instanceof NeedInput) {
        const rid = await this.writeRun(task, "paused", started, "input-required: " + String(e.message).slice(0, 400));
        const mid = await this.writeMessage(task, "question", String(e.message));
        await this.bus.updateRecord(this.T.tasks, task.record_id, {
          Status: "input-required", Latest_Run: rid, Status_Msg: mid, Heartbeat_At: "",
        });
        log(`input-required ${taskId}: ${String(e.message).slice(0, 120)}`);
      } else {
        const retries = Number(f1(task, "Retry_Count")) || 0;
        const rid = await this.writeRun(task, "failed", started, String(e.message ?? e).slice(0, 800));
        if (retries < MAX_RETRIES) {
          await this.bus.updateRecord(this.T.tasks, task.record_id, {
            Status: "submitted", Latest_Run: rid, Claimed_By: "", Heartbeat_At: "",
            Retry_Count: retries + 1,
          });
          log(`failed, will retry ${taskId}: ${String(e.message ?? e).slice(0, 200)}`);
        } else {
          await this.writeMessage(task, "notice", "执行失败且已达重试上限：" + String(e.message ?? e).slice(0, 500));
          await this.bus.updateRecord(this.T.tasks, task.record_id, {
            Status: "failed", Latest_Run: rid, Heartbeat_At: "",
          });
          log(`failed permanently ${taskId}: ${String(e.message ?? e).slice(0, 200)}`);
        }
      }
    } finally {
      clearInterval(hbTimer);
    }
  }

  async handleTask(task, caps) {
    const taskId = f1(task, "Task_ID");
    const skill = f1(task, "Skill_ID");
    const hop = Number(f1(task, "Hop_Count")) || 0;
    if (hop > HOP_LIMIT) {
      const rid = await this.writeRun(task, "failed", nowStr(),
        `hop count ${hop} exceeds limit ${HOP_LIMIT} (circuit breaker)`);
      await this.writeMessage(task, "notice", `熔断：Hop_Count=${hop} 超过上限 ${HOP_LIMIT}，任务终止。`);
      await this.bus.updateRecord(this.T.tasks, task.record_id, { Status: "failed", Latest_Run: rid });
      log("circuit-broken " + taskId);
      return;
    }
    // 幂等对账：已有 result 消息但状态未关 → 直接关单
    const msgs = await this.listMessages(taskId);
    if (msgs.some((m) => f1(m, "Kind") === "result")) {
      await this.bus.updateRecord(this.T.tasks, task.record_id, { Status: "completed" });
      log("reconciled completed " + taskId);
      return;
    }
    if (f1(task, "Approval_Class") === "approve" && !(await this.authApproved(task))) {
      await this.askApproval(task);
      return;
    }
    if (!caps.has(skill) || !this.commands[skill]) {
      await this.writeMessage(task, "notice",
        `拒收：本节点无此能力或执行器未装：${skill || "(空)"}（已登记能力：${[...caps].sort().join(", ") || "无"}）`);
      await this.bus.updateRecord(this.T.tasks, task.record_id, { Status: "rejected" });
      log("rejected (no capability) " + taskId);
      return;
    }
    if (this.commands[skill]?.context === "carrier" && !(await pingCarrier(this.cfg.carrierSocket))) {
      await this.writeMessage(task, "notice",
        "拒收：本能力的执行语境为 carrier（用户终端代跑），但 carrier 当前离线；按规矩不静默改走直跑，请先在终端启动 hub-node host 后重派。");
      await this.bus.updateRecord(this.T.tasks, task.record_id, { Status: "rejected" });
      log("rejected (carrier offline) " + taskId);
      return;
    }
    await this.execute(task);
  }

  // input-required 且归我认领的任务：question 之后出现 answer 则在原任务续跑。
  async resumeCheck(task) {
    if (f1(task, "Claimed_By") !== this.cfg.node) return;
    const msgs = await this.listMessages(f1(task, "Task_ID"));
    let qi = -1;
    msgs.forEach((m, i) => { if (f1(m, "Kind") === "question") qi = i; });
    if (qi < 0) return;
    const answers = [];
    for (let i = qi + 1; i < msgs.length; i++) {
      if (f1(msgs[i], "Kind") === "answer") answers.push(await this.msgText(msgs[i]));
    }
    if (answers.length) {
      log(`resuming ${f1(task, "Task_ID")} with ${answers.length} answer(s)`);
      await this.execute(task, answers);
    }
  }

  // 唤醒等待：飞书事件订阅（长连接）为主通道，事件一到立刻扫表；
  // doorbellFile 增长（同机其他接收端收到事件时）同样唤醒；
  // 两者都不可用时退回 pollSec 间隔轮询。等满 sweepSec 必做一次对账扫表，
  // 因为事件断线不补发——对账是安全网，不是主通道。
  async waitWake() {
    // 注意：不在此处清 _wakeFlag。清零点在主循环扫表之前（见 run()）：
    // 扫表期间到达的事件必须保留到这里，让下一轮立刻再扫一次，
    // 否则「事件比任务行先落库」时唤醒会被清掉、只能等对账兜底。
    const size = () => {
      if (!this.cfg.doorbellFile) return -1;
      try { return fs.statSync(this.cfg.doorbellFile).size; } catch { return -1; }
    };
    const start = size();
    const eventDriven = this._wsUp || start >= 0;
    const maxWait = (eventDriven ? this.cfg.sweepSec : this.cfg.pollSec) * 1000;
    let waited = 0;
    while (waited < maxWait) {
      await new Promise((res) => setTimeout(res, 1000));
      waited += 1000;
      if (this._wakeFlag) {
        log("event: waking");
        return;
      }
      if (this.cfg.doorbellFile && size() !== start) {
        log("doorbell: event arrived, waking");
        return;
      }
    }
  }

  startEventReceiver() {
    if (!this.cfg.events) return;
    const receiver = new FeishuEventReceiver({
      appId: this.bus.appId,
      appSecret: this.bus.appSecret,
      baseToken: this.bus.baseToken,
      doorbellFile: this.cfg.doorbellFile,
      onEvent: () => { this._wakeFlag = true; },
      onStatus: (up) => { this._wsUp = up; },
      log,
    });
    receiver.start();
  }

  async run() {
    log(`node daemon ${DAEMON_VERSION} starting on ${this.cfg.node}`);
    // 常驻进程的第一原则：启动期任何一步失败都不许死，进主循环重试。
    try { await this.bus.tenantToken(); } catch (e) {
      log("initial token failed (will retry in loop): " + e.message);
    }
    this.startEventReceiver();
    try { await this.reclaimStale(); } catch (e) {
      log("initial reclaim failed: " + e.message);
    }
    this._capsReady = false;
    for (;;) {
      // 唤醒标志在扫表前消费：本次扫表会看到最新状态，扫表之后
      // 再到的事件由 waitWake 立刻响应，不会被误清。
      this._wakeFlag = false;
      try {
        if (!this._capsReady) {
          await this.ensureCapabilities();
          this._capsReady = true;
        }
        await this.syncCarrierAvailability();
        this.loadCommands();
        const caps = await this.myCapabilities();
        const tasks = await this.bus.listRecords(this.T.tasks);
        for (const t of tasks) {
          if (f1(t, "Target_Node") === this.cfg.node && f1(t, "Status") === "submitted") {
            await this.handleTask(t, caps);
          }
        }
        for (const t of tasks) {
          if (f1(t, "Target_Node") === this.cfg.node && f1(t, "Status") === "input-required") {
            await this.resumeCheck(t);
          }
        }
      } catch (e) {
        log("poll error: " + e.message);
      }
      await this.waitWake();
    }
  }
}
