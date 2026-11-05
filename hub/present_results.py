#!/usr/bin/env python3
"""Agent 中台结果回注扫描器（枢纽侧，标准 v3）。

用法：
  present_results.py --list         输出未呈递的终态/待处理任务（JSON，每行一条），无则输出空
  present_results.py --mark id1,id2 把这些任务记录的 Presented 置 Yes（呈递成功后调用）

呈递范围（v3）：终态 completed/failed、需机主动作的 input-required/auth-required、
被拒收 rejected。
内容来源：该任务最新一条 result/question/auth_request/notice 消息（Messages 表）；
执行结果与报错取 Latest_Run 的 Outcome/Error_Log。
数据源：飞书多维表格中台 Base，经 lark-cli 以操作者用户身份读取
（与 hub_api.py 的 bot 身份读法等价，选此路是让呈递天然带操作者视角；
CLI 命令可用环境变量 LARK_CLI 覆盖，默认 PATH 上的 lark-cli）。
"""
import json
import os
import shlex
import subprocess
import sys

from hub_api import BASE_TOKEN as BASE, MESSAGES, PARTS, RUNS, TASKS

CLI = shlex.split(os.environ.get("LARK_CLI", "lark-cli"))

PRESENT_STATUSES = {"completed", "failed", "input-required", "auth-required", "rejected"}
MSG_KINDS = ("result", "question", "auth_request", "notice", "answer", "auth_decision")


def cli_json(args):
    out = subprocess.run(CLI + args, capture_output=True, text=True, timeout=120)
    raw = out.stdout
    i = raw.find("{")
    if i < 0:
        raise RuntimeError(f"lark-cli no json output: {raw[:200]} {out.stderr[:200]}")
    return json.loads(raw[i:])


def list_table(table_id):
    d = cli_json(["base", "+record-list", "--as", "user", "--base-token", BASE,
                  "--table-id", table_id, "--format", "json", "--limit", "200"])
    data = d["data"]
    cols = data["fields"]
    ids = data["record_id_list"]
    rows = []
    for rid, row in zip(ids, data["data"]):
        m = dict(zip(cols, row))
        m["_record_id"] = rid
        rows.append(m)
    return rows


def sel(v):
    if isinstance(v, list):
        return v[0] if v else ""
    return v or ""


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--mark":
        ids = [x for x in sys.argv[2].split(",") if x]
        for rid in ids:
            cli_json(["base", "+record-upsert", "--as", "user", "--base-token", BASE,
                      "--table-id", TASKS, "--record-id", rid, "--json",
                      json.dumps({"Presented": ["Yes"]})])
        print(f"marked {len(ids)}")
        return
    tasks = list_table(TASKS)
    runs = list_table(RUNS)
    msgs = list_table(MESSAGES)
    parts = list_table(PARTS)
    text_by_parent = {}
    for p in parts:
        if sel(p.get("Kind")) == "text":
            text_by_parent.setdefault(sel(p.get("Parent_ID")), []).append(sel(p.get("Text")))
    runs_by_id = {sel(r.get("Run_ID")): r for r in runs}
    runs_by_task = {}
    for r in runs:
        runs_by_task.setdefault(sel(r.get("Task_Ref")), []).append(r)
    msgs_by_task = {}
    for m in msgs:
        msgs_by_task.setdefault(sel(m.get("Task_ID")), []).append(m)
    out = []
    for t in tasks:
        status = sel(t.get("Status"))
        if status not in PRESENT_STATUSES:
            continue
        if sel(t.get("Presented")) == "Yes":
            continue
        task_id = sel(t.get("Task_ID"))
        tmsgs = [m for m in msgs_by_task.get(task_id, []) if sel(m.get("Kind")) in MSG_KINDS]
        last_msg = tmsgs[-1] if tmsgs else {}
        run = runs_by_id.get(sel(t.get("Latest_Run"))) or (
            runs_by_task.get(task_id, [{}])[-1] if runs_by_task.get(task_id) else {})
        out.append({
            "record_id": t["_record_id"],
            "task_id": task_id,
            "title": sel(t.get("Title")),
            "status": status,
            "target": sel(t.get("Target_Node")),
            "msg_kind": sel(last_msg.get("Kind")),
            "msg_from": sel(last_msg.get("From_Node")),
            "message": "\n".join(text_by_parent.get(sel(last_msg.get("Msg_ID")), [])),
            "artifact_ref": sel(last_msg.get("Artifact_Ref")),
            "outcome": sel(run.get("Outcome")),
            "error": sel(run.get("Error_Log")),
        })
    for item in out:
        print(json.dumps(item, ensure_ascii=False))


if __name__ == "__main__":
    main()
