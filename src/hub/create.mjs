// hub 角色建单。严格按「instruction 消息 → Parts → Tasks 行」写入。
// Tasks 行是节点的触发信号，必须最后写，否则节点会抢跑、读到空参数。
// 参数里的执行控制键直接拒绝，规则用 kernel 的 controlKeysIn，写之前就停。

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { controlKeysIn } from "../kernel.mjs";
import { f1 } from "../bus/feishu.mjs";

const APPROVALS = new Set(["auto", "notify", "approve"]);
// 与 src/kernel.mjs 的 HOP_LIMIT 对齐。超过 8 的单节点会直接熔断，这里不落表。
const HOP_LIMIT = 8;

export function formatCreatedAt(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function assertNoControl(obj) {
  const bad = controlKeysIn(obj);
  if (!bad.length) return;
  throw new Error(
    `拒绝建单：params 含执行控制键（${bad.join(", ")}）。要执行的命令、目录、语境、Agent 与权限只来自目标节点本机 commands.json；唯一例外是 timeout_sec。`,
  );
}

export function parseParams(raw) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "object") {
    if (Array.isArray(raw)) throw new Error("params 必须是 JSON 对象");
    assertNoControl(raw);
    return raw;
  }
  let text = String(raw);
  if (text.startsWith("@")) {
    const file = text.slice(1);
    if (!file) throw new Error("--params @文件 缺少路径");
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new Error("读 params 文件失败：" + e.message);
    }
  }
  if (!String(text).trim()) return undefined;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("params 不是合法 JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("params 必须是 JSON 对象");
  assertNoControl(obj);
  return obj;
}

export function parseCreateArgv(argv) {
  const out = {
    configDir: "", to: "", cap: "", text: "", paramsRaw: undefined, context: "", ref: "", approval: "",
  };
  const take = (i, flag) => {
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${flag} 需要参数`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--config") out.configDir = take(i, flag);
    else if (flag === "--to") out.to = take(i, flag);
    else if (flag === "--cap") out.cap = take(i, flag);
    else if (flag === "--text") out.text = take(i, flag);
    else if (flag === "--params") out.paramsRaw = take(i, flag);
    else if (flag === "--context") out.context = take(i, flag);
    else if (flag === "--ref") out.ref = take(i, flag);
    else if (flag === "--approval") out.approval = take(i, flag);
    else throw new Error("无法识别的参数：" + flag);
    if (flag.startsWith("--")) i++;
  }
  if (!String(out.to).trim()) throw new Error("task create 需要 --to <node>");
  if (!String(out.cap).trim()) throw new Error("task create 需要 --cap <cap_id>");
  return out;
}

function splitRefs(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  const ids = String(raw).split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of ids) {
    if (/\s/.test(id)) throw new Error("Ref_Task_IDs 里有无法识别的任务号：" + id);
  }
  return ids;
}

function titleOf(text, cap, node) {
  const line = String(text ?? "").split("\n").map((item) => item.trim()).find(Boolean);
  const base = line || `${cap} @ ${node}`;
  return base.length > 200 ? base.slice(0, 200) + "…" : base;
}

function freshTaskId(taken, now) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  for (let i = 0; i < 8; i++) {
    const id = `TASK-${day}-${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
  throw new Error("无法生成不重复的 Task_ID");
}

export async function createTask({
  bus, to, cap, text = "", params, context = "", ref = "", approval = "", now = new Date(),
}) {
  if (!bus?.tables?.messages || !bus.tables.parts || !bus.tables.tasks) {
    throw new Error("总线缺少 messages / parts / tasks 表");
  }
  const node = String(to ?? "").trim();
  const skill = String(cap ?? "").trim();
  if (!node) throw new Error("task create 需要 --to <node>");
  if (!skill) throw new Error("task create 需要 --cap <cap_id>");
  const data = parseParams(params);
  const approvalClass = String(approval ?? "").trim();
  if (approvalClass && !APPROVALS.has(approvalClass)) {
    throw new Error("--approval 只能是 auto、notify 或 approve");
  }
  const refs = splitRefs(ref);
  const clock = now instanceof Date ? now : new Date(now);
  // 先只读。任何拒绝都发生在第一笔写之前。
  const existing = await bus.listRecords(bus.tables.tasks);
  const taken = new Set(existing.map((row) => String(f1(row, "Task_ID") ?? "")).filter(Boolean));
  let hop = 0;
  if (refs.length) {
    const missing = [];
    for (const id of refs) {
      const parent = existing.find((row) => String(f1(row, "Task_ID") ?? "") === id);
      if (!parent) {
        missing.push(id);
        continue;
      }
      const parentHop = Number(f1(parent, "Hop_Count"));
      const normalized = Number.isFinite(parentHop) && parentHop > 0 ? parentHop : 0;
      if (normalized + 1 > hop) hop = normalized + 1;
    }
    if (missing.length) throw new Error("引用的任务不存在：" + missing.join(","));
    if (hop > HOP_LIMIT) {
      throw new Error(`拒绝建单：派生后 Hop_Count=${hop} 超过上限 ${HOP_LIMIT}`);
    }
  }
  const taskId = freshTaskId(taken, clock);
  const contextId = String(context ?? "").trim() || `CTX-${taskId.slice("TASK-".length)}`;
  const msgId = `MSG-${taskId.slice("TASK-".length)}-01`;
  const createdAt = formatCreatedAt(clock);
  const instruction = String(text ?? "").slice(0, 4000);

  const messageFields = {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: contextId,
    From_Node: "hub",
    To_Node: node,
    Role: "user",
    Kind: "instruction",
    Created_At: createdAt,
  };
  if (refs.length) messageFields.Ref_Task_IDs = refs.join(",");
  await bus.createRecord(bus.tables.messages, messageFields);

  let seq = 0;
  if (instruction.trim()) {
    seq += 1;
    await bus.createRecord(bus.tables.parts, {
      Part_ID: `${msgId}-P${seq}`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: seq,
      Kind: "text",
      Text: instruction,
    });
  }
  if (data) {
    seq += 1;
    await bus.createRecord(bus.tables.parts, {
      Part_ID: `${msgId}-P${seq}`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: seq,
      Kind: "data",
      Data: JSON.stringify(data),
    });
  }

  const taskFields = {
    Task_ID: taskId,
    Title: titleOf(instruction, skill, node),
    Source: "hub",
    Target_Node: node,
    Skill_ID: skill,
    Status: "submitted",
    Hop_Count: hop,
    Idempotency_Key: `hub-${randomUUID()}`,
    Context_ID: contextId,
    Presented: "No",
    Retry_Count: 0,
  };
  if (approvalClass) taskFields.Approval_Class = approvalClass;
  // 最后写任务行。前面的消息和 Parts 已经落表，节点被这条记录叫醒时读得到参数。
  await bus.createRecord(bus.tables.tasks, taskFields);
  return taskId;
}
