#!/usr/bin/env python3
"""审批卡发送器（VM 侧，标准 v2）：扫 Tasks 中 auth-required 的任务，
给操作者发枢纽 bot 审批卡。已发卡的任务记在 approval_state.json，不重复发。
点击回调由 event_receiver.py 处理（批准→auth_decision 消息＋回 submitted；驳回→canceled）。
用法：approval_watcher.py（单次扫描；可由 cron/循环调用）
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hub_api import TASKS, USER_OPEN_ID, f1, list_records, send_card

STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "approval_state.json")


def load_state():
    if os.path.exists(STATE):
        with open(STATE) as f:
            return json.load(f)
    return {}


def save_state(s):
    with open(STATE, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)


def build_card(task):
    payload = f1(task, "Context_ID")
    rid = task["record_id"]
    tid = f1(task, "Task_ID")
    return {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": "中台任务待审批"},
                   "template": "orange"},
        "elements": [
            {"tag": "div", "fields": [
                {"is_short": True, "text": {"tag": "lark_md", "content": "**任务**\n" + f1(task, "Title")}},
                {"is_short": True, "text": {"tag": "lark_md", "content": "**编号**\n" + tid}},
                {"is_short": True, "text": {"tag": "lark_md", "content": "**目标节点**\n" + f1(task, "Target_Node")}},
                {"is_short": True, "text": {"tag": "lark_md", "content": "**技能**\n" + (f1(task, "Skill_ID") or "-")}},
            ]},
            {"tag": "div", "text": {"tag": "lark_md", "content": "**上下文**\n" + (payload or "-")}},
            {"tag": "action", "actions": [
                {"tag": "button", "text": {"tag": "plain_text", "content": "同意执行"},
                 "type": "primary",
                 "value": {"decision": "approve", "record_id": rid, "task_id": tid}},
                {"tag": "button", "text": {"tag": "plain_text", "content": "驳回"},
                 "type": "danger",
                 "value": {"decision": "reject", "record_id": rid, "task_id": tid}},
            ]},
        ],
    }


def main():
    state = load_state()
    sent = 0
    for t in list_records(TASKS):
        if f1(t, "Status") != "auth-required":
            continue
        rid = t["record_id"]
        if state.get(rid, {}).get("card_sent"):
            continue
        res = send_card(USER_OPEN_ID, build_card(t))
        state[rid] = {"card_sent": True, "message_id": res.get("message_id", "")}
        sent += 1
        print("card sent for", f1(t, "Task_ID"))
    save_state(state)
    print("done, sent", sent)


if __name__ == "__main__":
    main()
