#!/usr/bin/env node
// agent-inbox 执行器（通用收件箱）：
// 支持 json 与 agent 两种模式。从 stdin 读取任务信封或提示词，
// 将收到的任务结构化持久化到本地收件箱队列（agent_inbox.jsonl），
// 并输出标准回执。供独立 Agent 节点或编排宿主接单排队。

import fs from "node:fs";
import path from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const raw = input.trim();
  const cwd = process.cwd();
  const inboxFile = process.env.AGENT_INBOX_PATH || path.join(cwd, "agent_inbox.jsonl");

  let isJson = false;
  let parsedJson = null;
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      parsedJson = JSON.parse(raw);
      isJson = true;
    } catch {}
  }

  const nowIso = new Date().toISOString();
  let taskId = "";
  let record = {};

  if (isJson && parsedJson && typeof parsedJson === "object") {
    // JSON 模式：信封包含 _hub 与 params
    const { _hub, ...params } = parsedJson;
    taskId = _hub?.task_id || "TASK-UNKNOWN";
    record = {
      task_id: taskId,
      received_at: nowIso,
      mode: "json",
      hub: _hub || null,
      params,
    };
  } else {
    // Agent 模式：从 prompt 或包含的 input.json 文件路径中解析
    let matchedFile = null;
    const m = raw.match(/任务数据文件（绝对路径）：([^\r\n]+)/);
    if (m && m[1]) matchedFile = m[1].trim();

    let taskData = null;
    if (matchedFile) {
      try {
        taskData = JSON.parse(fs.readFileSync(matchedFile, "utf8"));
      } catch {}
    }

    taskId = taskData?.task?.Task_ID || "TASK-UNKNOWN";
    record = {
      task_id: taskId,
      received_at: nowIso,
      mode: "agent",
      input_file: matchedFile || null,
      task_data: taskData,
      raw_prompt: matchedFile ? undefined : raw.slice(0, 2000),
    };
  }

  try {
    fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
    fs.appendFileSync(inboxFile, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch (e) {
    console.error("写入收件箱失败：" + e.message);
  }

  if (isJson) {
    console.log(JSON.stringify({
      summary: `已收录入收件箱（Task: ${taskId}）`,
      inbox: inboxFile,
      task_id: taskId,
    }));
  } else {
    console.log(`已将任务 ${taskId} 收录入本地收件箱。`);
    console.log(`ARTIFACT: ${inboxFile}`);
    console.log(`ARTIFACT_NAME: agent_inbox.jsonl`);
  }
});
