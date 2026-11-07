// hub 角色的陈旧任务告警。只通知机主，不改任务、不回收租约。
// working：心跳为空、无法解析，或早于 20 分钟（与节点 STALE_MIN 一致）。
// submitted：仍无人认领且已超过 20 分钟。Tasks 没有创建时间，能解析到首条
// instruction 的 Created_At 就用它，否则从本进程第一次看见该任务起算。
// 每种情况每个任务只发一次，记在配置目录的 stale_state.json，不进仓库。

import fs from "node:fs";
import path from "node:path";
import { f1 } from "../bus/feishu.mjs";

export const STALE_MIN = 20;
const STALE_MS = STALE_MIN * 60_000;
const HB_OFF = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)([+-])(\d{2})(\d{2})$/;

export function parseHeartbeat(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const sec = Math.abs(value) > 10_000_000_000 ? value / 1000 : value;
    return new Date(sec * 1000);
  }
  let text = String(value).trim();
  if (!text) return null;
  const matched = HB_OFF.exec(text);
  if (matched) {
    let head = matched[1].replace(" ", "T");
    if (head.length === 16) head += ":00";
    text = `${head}${matched[2]}${matched[3]}:${matched[4]}`;
  } else {
    text = text.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) text += ":00";
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isStaleWorking(heartbeat, now = new Date()) {
  const ts = parseHeartbeat(heartbeat);
  if (!ts) return true;
  const ref = now instanceof Date ? now : new Date(now);
  return ref.getTime() - ts.getTime() > STALE_MS;
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const alerted = Array.isArray(parsed?.alerted)
      ? parsed.alerted.filter((k) => typeof k === "string")
      : [];
    const seen = {};
    if (parsed?.seen && typeof parsed.seen === "object" && !Array.isArray(parsed.seen)) {
      for (const [key, value] of Object.entries(parsed.seen)) {
        const n = Number(value);
        if (Number.isFinite(n)) seen[key] = n;
      }
    }
    return { alerted, seen };
  } catch (e) {
    if (e.code === "ENOENT") return { alerted: [], seen: {} };
    return { alerted: [], seen: {}, broken: e.message };
  }
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ alerted: state.alerted, seen: state.seen }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function instructionAgeMs(messages, taskId, nowMs) {
  let oldest = null;
  for (const msg of messages) {
    if (String(f1(msg, "Task_ID") ?? "") !== taskId) continue;
    if (f1(msg, "Kind") !== "instruction") continue;
    const ts = parseHeartbeat(f1(msg, "Created_At"));
    if (!ts) continue;
    if (oldest == null || ts.getTime() < oldest) oldest = ts.getTime();
  }
  if (oldest == null) return null;
  return nowMs - oldest;
}

function alertText(kind, task) {
  const taskId = String(f1(task, "Task_ID") ?? "");
  const target = String(f1(task, "Target_Node") ?? "") || "-";
  if (kind === "working") {
    const hb = String(f1(task, "Heartbeat_At") ?? "").trim();
    return [
      "【陈旧任务】执行中的任务心跳超时",
      `编号：${taskId}`,
      `目标节点：${target}`,
      `心跳：${hb || "（无）"}`,
      `已超过 ${STALE_MIN} 分钟没有心跳，或心跳缺失。枢纽只告警，不回收租约，也不改状态。`,
    ].join("\n");
  }
  return [
    "【陈旧任务】已提交的任务无人认领",
    `编号：${taskId}`,
    `目标节点：${target}`,
    `已超过 ${STALE_MIN} 分钟仍是 submitted，且没有 Claimed_By。枢纽只告警，不改状态。`,
  ].join("\n");
}

export class StaleService {
  constructor({ bus, ownerOpenId = "", statePath, log, now = () => Date.now() }) {
    this.bus = bus;
    this.ownerOpenId = String(ownerOpenId ?? "").trim();
    this.statePath = statePath;
    this.log = log ?? (() => {});
    this.now = now;
  }

  async scan() {
    if (!this.statePath) {
      this.log("陈旧告警没有状态文件路径，本轮跳过，避免无法去重仍发消息");
      return 0;
    }
    const state = readState(this.statePath);
    if (state.broken) this.log("stale_state.json 读失败，本轮按未告警处理：" + state.broken);
    const alerted = new Set(state.alerted);
    const nowMs = Number(this.now());
    const tasks = await this.bus.listRecords(this.bus.tables.tasks);
    const submittedIds = [];
    for (const task of tasks) {
      if (f1(task, "Status") !== "submitted") continue;
      if (String(f1(task, "Claimed_By") ?? "").trim()) continue;
      const taskId = String(f1(task, "Task_ID") ?? "");
      if (taskId) submittedIds.push(taskId);
    }
    let messages = null;
    if (submittedIds.some((id) => !alerted.has(`${id}\tsubmitted`))) {
      messages = await this.bus.listRecords(this.bus.tables.messages);
    }
    const due = [];
    const liveSubmitted = new Set();
    let seenDirty = false;
    for (const task of tasks) {
      const taskId = String(f1(task, "Task_ID") ?? "");
      if (!taskId) continue;
      const status = String(f1(task, "Status") ?? "");
      if (status === "working") {
        if (!isStaleWorking(f1(task, "Heartbeat_At"), new Date(nowMs))) continue;
        const key = `${taskId}\tworking`;
        if (alerted.has(key)) continue;
        due.push({ task, key, kind: "working" });
        continue;
      }
      if (status !== "submitted") continue;
      if (String(f1(task, "Claimed_By") ?? "").trim()) continue;
      liveSubmitted.add(taskId);
      const key = `${taskId}\tsubmitted`;
      if (alerted.has(key)) continue;
      const age = instructionAgeMs(messages ?? [], taskId, nowMs);
      if (age != null) {
        if (age > STALE_MS) due.push({ task, key, kind: "submitted" });
        continue;
      }
      if (state.seen[taskId] == null) {
        state.seen[taskId] = nowMs;
        seenDirty = true;
        continue;
      }
      if (nowMs - Number(state.seen[taskId]) > STALE_MS) {
        due.push({ task, key, kind: "submitted" });
      }
    }
    for (const taskId of Object.keys(state.seen)) {
      if (!liveSubmitted.has(taskId)) {
        delete state.seen[taskId];
        seenDirty = true;
      }
    }
    const owner = String(this.ownerOpenId ?? "").trim();
    if (!owner) {
      if (seenDirty) {
        try { writeState(this.statePath, state); } catch (e) {
          this.log("stale_state.json 写失败：" + (e?.message ?? e));
        }
      }
      if (due.length) this.log("hub 未配置机主 open_id，陈旧任务只记在日志里，本轮不标记已告警");
      for (const item of due) this.log("stale " + item.kind + " " + f1(item.task, "Task_ID"));
      return 0;
    }
    let sent = 0;
    for (const item of due) {
      try {
        await this.bus.sendMessage(owner, "text", { text: alertText(item.kind, item.task) });
      } catch (e) {
        this.log("陈旧告警发送失败 " + f1(item.task, "Task_ID") + "：" + (e?.message ?? e));
        continue;
      }
      if (!alerted.has(item.key)) {
        alerted.add(item.key);
        state.alerted.push(item.key);
      }
      sent += 1;
      this.log("stale alerted " + item.kind + " " + f1(item.task, "Task_ID"));
    }
    if (sent || seenDirty) {
      try { writeState(this.statePath, state); } catch (e) {
        this.log("stale_state.json 写失败，告警可能在下一轮重发：" + (e?.message ?? e));
      }
    }
    return sent;
  }
}
