// src/inbox.mjs —— 独立 Agent 收件箱操作库。
// 承载 agent_inbox.jsonl 的原子读写、心跳核验与 lah inbox (done|ask|fail) 的总线状态流转。
// 严格遵守红线：只能操作本节点认领且处于 working 的任务；node 角色绝不写 auth_decision 与 canceled。

import fs from "node:fs";
import path from "node:path";
import { f1 } from "./bus/feishu.mjs";

export function inboxFilePath(configDir) {
  return path.join(configDir, "agent_inbox.jsonl");
}

export function readInbox(configDir) {
  const file = inboxFilePath(configDir);
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const list = [];
    for (const l of lines) {
      try { list.push(JSON.parse(l)); } catch {}
    }
    return list;
  } catch {
    return [];
  }
}

export function writeInbox(configDir, list) {
  const file = inboxFilePath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const content = list.map((item) => JSON.stringify(item)).join("\n") + (list.length ? "\n" : "");
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function enqueueOrUpdateInbox(configDir, item) {
  const list = readInbox(configDir);
  const idx = list.findIndex((x) => x.task_id === item.task_id);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      ...item,
      updated_at: new Date().toISOString(),
      status: "pending", // 置回 pending 等待 Agent 消费
    };
  } else {
    list.push({
      ...item,
      status: "pending",
      created_at: new Date().toISOString(),
    });
  }
  writeInbox(configDir, list);
}

export function popPendingInbox(configDir, { pop = false } = {}) {
  const list = readInbox(configDir);
  const pending = list.filter((item) => item.status === "pending");
  if (pop && pending.length > 0) {
    for (const p of pending) {
      p.status = "acked";
      p.acked_at = new Date().toISOString();
    }
    writeInbox(configDir, list);
  }
  return pending;
}

export function markInboxStatus(configDir, taskId, status, extra = {}) {
  const list = readInbox(configDir);
  const target = list.find((x) => x.task_id === taskId);
  if (target) {
    target.status = status;
    Object.assign(target, extra);
    writeInbox(configDir, list);
    return true;
  }
  return false;
}

export function initiatorOf(task, messages = []) {
  if (Array.isArray(messages) && messages.length > 0) {
    const instr = messages.find((m) => f1(m, "Kind") === "instruction");
    if (instr) {
      const from = String(f1(instr, "From_Node") ?? "").trim();
      if (from) return from;
    }
  }
  const source = String(f1(task, "Source") ?? "").trim();
  if (source) return source;
  return "hub";
}

function nowMinuteStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function verifyWorkingTask(bus, node, taskId) {
  const tasks = await bus.listRecords(bus.tables.tasks);
  const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  const target = f1(task, "Target_Node");
  const status = f1(task, "Status");
  const claimedBy = f1(task, "Claimed_By");
  if (target !== node) throw new Error(`任务目标节点是 ${target}，不是当前节点 ${node}`);
  if (status !== "working") throw new Error(`任务当前状态是 ${status}，不是 working`);
  if (claimedBy !== node) throw new Error(`任务当前认领者是 ${claimedBy}，不是当前节点 ${node}`);
  return task;
}

async function nextMsgSeq(bus, taskId) {
  const msgs = (await bus.listRecords(bus.tables.messages)).filter((m) => f1(m, "Task_ID") === taskId);
  let max = 0;
  for (const m of msgs) {
    const id = String(f1(m, "Msg_ID") ?? "");
    const match = id.match(/-(\d+)$/);
    if (match) {
      const n = Number(match[1]);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

export async function handleInboxDone({ bus, configDir, node, taskId, text, artifact }) {
  const task = await verifyWorkingTask(bus, node, taskId);
  const messages = await bus.listRecords(bus.tables.messages);
  const taskMsgs = messages.filter((m) => f1(m, "Task_ID") === taskId);
  const recipient = initiatorOf(task, taskMsgs);

  let artifactId = "";
  if (artifact && bus.tables.artifacts) {
    const artCount = (await bus.listRecords(bus.tables.artifacts)).filter((a) => f1(a, "Task_ID") === taskId).length;
    artifactId = `${taskId}-A${artCount + 1}`;
    const artName = path.basename(artifact);
    await bus.createRecord(bus.tables.artifacts, {
      Artifact_ID: artifactId,
      Task_ID: taskId,
      Name: artName,
      Description: `Artifact for task ${taskId}: ${artName}`,
      Metadata: JSON.stringify({ path: artifact }),
    });
  }

  const seq = await nextMsgSeq(bus, taskId);
  const seqStr = String(seq).padStart(2, "0");
  const msgId = `MSG-${taskId.replace(/^TASK-/, "")}-${seqStr}`;
  const now = nowMinuteStr();

  const msgFields = {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: f1(task, "Context_ID"),
    From_Node: node,
    To_Node: recipient,
    Role: "agent",
    Kind: "result",
    Created_At: now,
  };
  if (artifactId) msgFields.Artifact_Ref = artifactId;
  await bus.createRecord(bus.tables.messages, msgFields);

  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: String(text ?? "").slice(0, 4000),
  });

  // 关 Runs 行
  let latestRunId = f1(task, "Latest_Run");
  if (latestRunId && bus.tables.runs) {
    const runs = await bus.listRecords(bus.tables.runs);
    const runRow = runs.find((r) => f1(r, "Run_ID") === latestRunId);
    if (runRow) {
      await bus.updateRecord(bus.tables.runs, runRow.record_id, {
        Status: "completed",
        Outcome: String(text ?? "").slice(0, 500),
        Ended_At: now,
      });
    }
  }

  // 更新任务行
  await bus.updateRecord(bus.tables.tasks, task.record_id, {
    Status: "completed",
    Status_Msg: msgId,
    Presented: "No",
    Heartbeat_At: "",
  });

  markInboxStatus(configDir, taskId, "done", { completed_at: new Date().toISOString() });
  return { taskId, msgId, recipient, artifactId };
}

export async function handleInboxAsk({ bus, configDir, node, taskId, text }) {
  const task = await verifyWorkingTask(bus, node, taskId);
  const messages = await bus.listRecords(bus.tables.messages);
  const taskMsgs = messages.filter((m) => f1(m, "Task_ID") === taskId);
  const recipient = initiatorOf(task, taskMsgs);

  const seq = await nextMsgSeq(bus, taskId);
  const seqStr = String(seq).padStart(2, "0");
  const msgId = `MSG-${taskId.replace(/^TASK-/, "")}-${seqStr}`;
  const now = nowMinuteStr();

  await bus.createRecord(bus.tables.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: f1(task, "Context_ID"),
    From_Node: node,
    To_Node: recipient,
    Role: "agent",
    Kind: "question",
    Created_At: now,
  });

  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: String(text ?? "").slice(0, 4000),
  });

  // 更新任务行为 input-required
  await bus.updateRecord(bus.tables.tasks, task.record_id, {
    Status: "input-required",
    Status_Msg: msgId,
  });

  markInboxStatus(configDir, taskId, "waiting-answer", { asked_at: new Date().toISOString(), question: text });
  return { taskId, msgId, recipient };
}

export async function handleInboxFail({ bus, configDir, node, taskId, text }) {
  const task = await verifyWorkingTask(bus, node, taskId);
  const messages = await bus.listRecords(bus.tables.messages);
  const taskMsgs = messages.filter((m) => f1(m, "Task_ID") === taskId);
  const recipient = initiatorOf(task, taskMsgs);

  const seq = await nextMsgSeq(bus, taskId);
  const seqStr = String(seq).padStart(2, "0");
  const msgId = `MSG-${taskId.replace(/^TASK-/, "")}-${seqStr}`;
  const now = nowMinuteStr();

  await bus.createRecord(bus.tables.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: f1(task, "Context_ID"),
    From_Node: node,
    To_Node: recipient,
    Role: "agent",
    Kind: "notice",
    Created_At: now,
  });

  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: String(text ?? "").slice(0, 4000),
  });

  // 关 Runs 行
  let latestRunId = f1(task, "Latest_Run");
  if (latestRunId && bus.tables.runs) {
    const runs = await bus.listRecords(bus.tables.runs);
    const runRow = runs.find((r) => f1(r, "Run_ID") === latestRunId);
    if (runRow) {
      await bus.updateRecord(bus.tables.runs, runRow.record_id, {
        Status: "failed",
        Error_Log: String(text ?? "").slice(0, 500),
        Ended_At: now,
      });
    }
  }

  // 更新任务行
  await bus.updateRecord(bus.tables.tasks, task.record_id, {
    Status: "failed",
    Status_Msg: msgId,
    Presented: "No",
    Heartbeat_At: "",
  });

  markInboxStatus(configDir, taskId, "failed", { failed_at: new Date().toISOString(), reason: text });
  return { taskId, msgId, recipient };
}
