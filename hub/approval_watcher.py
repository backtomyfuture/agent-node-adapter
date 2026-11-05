#!/usr/bin/env python3
"""审批卡发送器（VM 侧）：扫 Tasks 中 auth-required 的任务，
给机主发枢纽 bot 审批卡。已发卡的任务记在 approval_state.json，不重复发。
每成功发送一张就立刻落盘，避免中途异常导致整批重发。
HUB_OWNER_OPEN_ID 为空时直接退出，不静默空跑。
内容详情读 Status_Msg（当前 auth_request）在 Parts 里的 TextPart；
没有正文时回退到首条 instruction 的摘要与参数，再回退 Context_ID。
Context_ID 仍作辅助字段，避免机主只看到没有业务含义的会话编号。
点击回调由 event_receiver.py 处理（批准→auth_decision 消息＋回 submitted；驳回→canceled）。
用法：approval_watcher.py（单次扫描；可由 cron/循环调用）
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hub_api import MESSAGES, PARTS, TASKS, f1, list_records, send_card

STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "approval_state.json")
# 飞书卡片正文过长会拒发；截断后仍让机主看到主要指令。
_DETAIL_LIMIT = 2000
_SECRET_WORDS = {"password", "passwd", "secret", "token", "apikey", "authorization", "credential"}


def load_state():
    if os.path.exists(STATE):
        with open(STATE) as f:
            return json.load(f)
    return {}


def save_state(s):
    with open(STATE, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)


def _seq(part):
    try:
        return int(f1(part, "Seq") or 0)
    except (TypeError, ValueError):
        return 0


def _parts_of(parts, parent_id):
    parent = str(parent_id or "")
    rows = [p for p in parts if str(f1(p, "Parent_ID") or "") == parent]
    rows.sort(key=_seq)
    return rows


def _text_value(value):
    # 多维表格文本偶发成 {text: ...}；取不到正文就当空，走回退，别把结构体印上卡片。
    if isinstance(value, dict):
        return str(value.get("text") or "").strip()
    return str(value or "").strip()


def message_text(parts, parent_id):
    """按 Seq 拼接一条消息的 TextPart。空块跳过。"""
    chunks = []
    for part in _parts_of(parts, parent_id):
        if f1(part, "Kind") != "text":
            continue
        text = _text_value(f1(part, "Text"))
        if text:
            chunks.append(text)
    return "\n".join(chunks).strip()


def _secret_key(key):
    words = [w for w in str(key).lower().replace("-", "_").split("_") if w]
    if "api" in words and "key" in words:
        return True
    if "private" in words and "key" in words:
        return True
    return any(w in _SECRET_WORDS for w in words)


def _redact(obj):
    if isinstance(obj, dict):
        return {k: ("***" if _secret_key(k) else _redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


def _fmt_scalar(value):
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _fmt_params(obj):
    obj = _redact(obj)
    if isinstance(obj, dict):
        return "\n".join("%s: %s" % (k, _fmt_scalar(obj[k])) for k in sorted(obj, key=str))
    return _fmt_scalar(obj)


def message_params(parts, parent_id):
    """合并一条消息的 DataPart。任务参数在这里，不在 Tasks 行上。"""
    merged = {}
    extras = []
    for part in _parts_of(parts, parent_id):
        if f1(part, "Kind") != "data":
            continue
        raw = f1(part, "Data")
        if raw is None or raw == "":
            continue
        if isinstance(raw, dict):
            merged.update(raw)
            continue
        if isinstance(raw, list):
            extras.append(_fmt_params(raw))
            continue
        text = str(raw).strip()
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            extras.append(text)
            continue
        if isinstance(parsed, dict):
            merged.update(parsed)
        else:
            extras.append(_fmt_params(parsed))
    lines = []
    if merged:
        lines.append(_fmt_params(merged))
    lines.extend(item for item in extras if item)
    return "\n".join(lines).strip()


def _msg_seq(msg):
    mid = str(f1(msg, "Msg_ID") or "")
    tail = mid.rsplit("-", 1)[-1] if mid else ""
    if tail.isdigit():
        return int(tail)
    return 10 ** 9


def first_instruction(messages, task_id):
    """首条 instruction 才是建单时的指令与参数；后补的同名消息不算。"""
    task_id = str(task_id or "")
    rows = [m for m in messages
            if str(f1(m, "Task_ID") or "") == task_id and f1(m, "Kind") == "instruction"]
    if not rows:
        return None
    rows.sort(key=lambda m: (_msg_seq(m), str(f1(m, "Created_At") or ""), str(f1(m, "Msg_ID") or "")))
    return rows[0]


def _clip(text):
    text = (text or "").strip()
    if len(text) <= _DETAIL_LIMIT:
        return text
    return text[:_DETAIL_LIMIT].rstrip() + "…（已截断）"


def pending_content(task, messages=None, parts=None):
    """机主审批时要看的待执行内容。

    Status_Msg 指向当前 auth_request，正文在它的 TextPart。
    节点还没写入正文、或 Parts 读空时，用首条 instruction 的摘要和参数。
    两者都没有才退回 Context_ID，避免卡片空白。
    """
    messages = messages or []
    parts = parts or []
    status_msg = str(f1(task, "Status_Msg") or "").strip()
    if status_msg:
        body = message_text(parts, status_msg)
        if body:
            return _clip(body)
    instr = first_instruction(messages, f1(task, "Task_ID"))
    if instr:
        mid = f1(instr, "Msg_ID")
        summary = message_text(parts, mid)
        params = message_params(parts, mid)
        chunks = []
        if summary:
            chunks.append("摘要：" + summary)
        if params:
            chunks.append("参数：\n" + params)
        if chunks:
            return _clip("\n".join(chunks))
    return _clip(str(f1(task, "Context_ID") or ""))


def build_card(task, messages=None, parts=None):
    detail = pending_content(task, messages, parts) or "-"
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
                {"is_short": True, "text": {"tag": "lark_md", "content": "**上下文**\n" + (f1(task, "Context_ID") or "-")}},
            ]},
            {"tag": "div", "text": {"tag": "lark_md", "content": "**待执行内容**\n" + detail}},
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
    # 启动时读环境变量，不靠 import 时的快照：没配机主就退出，避免把卡片发到空 open_id。
    owner = (os.environ.get("HUB_OWNER_OPEN_ID") or "").strip()
    if not owner:
        print("approval_watcher: HUB_OWNER_OPEN_ID is empty, exit", file=sys.stderr)
        raise SystemExit(1)
    state = load_state()
    pending = []
    for t in list_records(TASKS):
        if f1(t, "Status") != "auth-required":
            continue
        rid = t["record_id"]
        if state.get(rid, {}).get("card_sent"):
            continue
        pending.append(t)
    # 没有待发卡的任务就不扫 Messages/Parts。有的话一轮只拉一次。
    messages = list_records(MESSAGES) if pending else []
    parts = list_records(PARTS) if pending else []
    sent = 0
    for t in pending:
        rid = t["record_id"]
        res = send_card(owner, build_card(t, messages, parts))
        state[rid] = {"card_sent": True, "message_id": res.get("message_id", "")}
        save_state(state)  # 逐卡落盘：下一张失败时已发出的不会整批重发
        sent += 1
        print("card sent for", f1(t, "Task_ID"))
    print("done, sent", sent)


if __name__ == "__main__":
    main()
