#!/usr/bin/env python3
"""Agent 中台事件接收端（枢纽侧）。

用 lark-oapi 长连接订阅 drive.file.bitable_record_changed_v1：事件逐行
追加到 events.log（JSONL）备查；防抖后触发呈递扫描（见 present_results.py）；
同时承接审批卡回调（批准/驳回 → 写 auth_decision 消息并流转状态）。
凭据读同目录 hub.env，不落日志。订阅注册须先以用户身份完成（见
docs/hub-integration.md「事件订阅注册」）。
"""
import json
import os
import time

import lark_oapi as lark
import lark_oapi.ws.client as _wsmod

# 若宿主机出站必须走代理：官方 SDK 默认强制直连（proxy=None），在此恢复
# 环境变量里的代理设置；无代理环境时本补丁无副作用。
_orig_kwargs = _wsmod._ws_connect_kwargs


def _patched_kwargs(headers=None):
    kw = _orig_kwargs(headers)
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        kw["proxy"] = proxy
    return kw


_wsmod._ws_connect_kwargs = _patched_kwargs

_HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(_HERE, "events.log")
EVENT_TYPE = "drive.file.bitable_record_changed_v1"


def load_creds():
    kv = {}
    with open(os.path.join(_HERE, "hub.env")) as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                kv[k] = v
    return kv["APP_ID"], kv["APP_SECRET"]


def dump(obj):
    try:
        return json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return str(obj)


QUEUE = os.path.join(_HERE, "present_queue.jsonl")
PRESENTER = os.path.join(_HERE, "present_results.py")
_scan_lock = __import__("threading").Lock()
_scan_timer = None


def _queue_key(obj):
    """同一 record 进入新中断态或终态时要能再入队，不能只按 record_id 永久去重。"""
    return (obj.get("record_id", ""), obj.get("status", "") or "",
            obj.get("status_msg", "") or "")


def _queue_scan():
    """事件触发后（防抖）扫未呈递任务，写入呈递队列，hook 会唤醒 agent 立即呈递。"""
    import subprocess
    import sys
    global _scan_timer
    with _scan_lock:
        _scan_timer = None
    try:
        env = dict(os.environ)
        # presenter 经 lark-cli 以用户身份读表；服务若以其他用户运行，
        # 用 HUB_LARK_CLI_HOME 指到 lark-cli 配置所在的家目录。
        if os.environ.get("HUB_LARK_CLI_HOME"):
            env["HOME"] = os.environ["HUB_LARK_CLI_HOME"]
        out = subprocess.run([sys.executable, PRESENTER, "--list"],
                             capture_output=True, text=True, timeout=120, env=env)
        items = []
        for line in out.stdout.strip().split("\n"):
            if line.strip():
                items.append(json.loads(line))
        if not items:
            return
        queued = set()
        if os.path.exists(QUEUE):
            with open(QUEUE) as f:
                for line in f:
                    try:
                        queued.add(_queue_key(json.loads(line)))
                    except Exception:
                        pass
        added = 0
        with open(QUEUE, "a") as f:
            for it in items:
                entry = {"record_id": it["record_id"],
                         "task_id": it.get("task_id", ""),
                         "status": it.get("status", "") or "",
                         "status_msg": it.get("status_msg", "") or ""}
                if _queue_key(entry) in queued:
                    continue
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                queued.add(_queue_key(entry))
                added += 1
        if added:
            print("present queue: +%d item(s)" % added, flush=True)
    except Exception as e:
        print("present queue scan failed:", e, flush=True)


def _schedule_scan():
    import threading
    global _scan_timer
    with _scan_lock:
        if _scan_timer is None:
            _scan_timer = threading.Timer(6.0, _queue_scan)
            _scan_timer.daemon = True
            _scan_timer.start()


def on_bitable_changed(data):
    payload = getattr(data, "event", None)
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "type": EVENT_TYPE,
           "event": json.loads(dump(payload)) if payload is not None else dump(data)}
    with open(LOG, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print("event received:", rec["ts"], flush=True)
    _schedule_scan()


def _dig(obj, name):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _operator_open_id(data):
    """卡片回调上的操作者。SDK 是对象，测试或原始事件也可能是 dict。"""
    event = _dig(data, "event")
    operator = _dig(event, "operator")
    open_id = _dig(operator, "open_id")
    return (open_id or "").strip()


def _reject_card(resp, toast, content):
    toast.type = "error"
    toast.content = content
    resp.toast = toast
    return resp


def on_card_action(data):
    """审批卡回调（标准 §8.3）：先校验操作者是机主，再写 auth_decision
    （In_Reply_To = 当前 Status_Msg）并流转状态。批准回 submitted 时保留 Status_Msg。"""
    import sys
    sys.path.insert(0, _HERE)
    from hub_api import BASE_TOKEN, MESSAGES, PARTS, TASKS, api, f1, list_records, update_record
    from lark_oapi.event.callback.model.p2_card_action_trigger import (
        CallBackToast, P2CardActionTriggerResponse)

    resp = P2CardActionTriggerResponse()
    toast = CallBackToast()
    # 卡片只发给机主不能代替这一校验。未配置机主时拒绝，不能空跑成「谁点都算」。
    owner = (os.environ.get("HUB_OWNER_OPEN_ID") or "").strip()
    operator = _operator_open_id(data)
    if not owner:
        print("WARN card action rejected: HUB_OWNER_OPEN_ID is unset", flush=True)
        return _reject_card(resp, toast, "未配置机主，已拒绝。")
    if operator != owner:
        print("WARN card action rejected: operator is not HUB_OWNER_OPEN_ID", flush=True)
        return _reject_card(resp, toast, "只有机主可以审批。")
    try:
        value = _dig(_dig(data, "event"), "action")
        value = _dig(value, "value") or {}
        if not isinstance(value, dict):
            raise RuntimeError("card action value is not an object")
        record_id = value.get("record_id", "")
        decision = value.get("decision", "")
        rows = [r for r in list_records(TASKS) if r["record_id"] == record_id]
        if not rows:
            raise RuntimeError("task record not found")
        task = rows[0]
        if f1(task, "Status") != "auth-required":
            toast.type = "info"
            toast.content = "任务状态已变化，未重复处理。"
        elif decision in ("approve", "reject"):
            # 节点只认 In_Reply_To 等于当前 Status_Msg 的决定；对不上就不写、不改状态。
            status_msg = f1(task, "Status_Msg") or ""
            if not status_msg:
                raise RuntimeError("task Status_Msg is empty; refuse unbound auth_decision")
            task_id = f1(task, "Task_ID")
            msgs = [m for m in list_records(MESSAGES) if f1(m, "Task_ID") == task_id]
            msg_id = "MSG-%s-%02d" % (task_id.replace("TASK-", ""), len(msgs) + 1)
            api("POST", "/bitable/v1/apps/%s/tables/%s/records" % (BASE_TOKEN, MESSAGES), {
                "fields": {
                    "Msg_ID": msg_id,
                    "Task_ID": task_id,
                    "Context_ID": f1(task, "Context_ID"),
                    "From_Node": "hub", "To_Node": f1(task, "Target_Node"),
                    "Role": "user", "Kind": "auth_decision",
                    "In_Reply_To": status_msg,
                    "Created_At": time.strftime("%Y-%m-%d %H:%M")}})
            api("POST", "/bitable/v1/apps/%s/tables/%s/records" % (BASE_TOKEN, PARTS), {
                "fields": {
                    "Part_ID": msg_id + "-P1", "Parent_ID": msg_id,
                    "Parent_Type": "message", "Seq": 1, "Kind": "text",
                    "Text": ("approved：操作者已在审批卡批准。" if decision == "approve"
                             else "rejected：操作者已在审批卡驳回。")}})
            api("POST", "/bitable/v1/apps/%s/tables/%s/records" % (BASE_TOKEN, PARTS), {
                "fields": {
                    "Part_ID": msg_id + "-P2", "Parent_ID": msg_id,
                    "Parent_Type": "message", "Seq": 2, "Kind": "data",
                    "Data": json.dumps({"decision": decision})}})
            if decision == "approve":
                # 回 submitted 后节点认领前仍用 Status_Msg 核对 auth_decision.In_Reply_To。
                # 必须原样写回，不能顺手清空（标准 §8.3）。
                update_record(TASKS, record_id, {
                    "Status": "submitted",
                    "Presented": "",
                    "Status_Msg": status_msg})
                toast.type = "success"
                toast.content = "已批准，任务重新入队执行。"
            else:
                update_record(TASKS, record_id, {"Status": "canceled"})
                toast.type = "info"
                toast.content = "已驳回，任务取消。"
        else:
            raise RuntimeError("unknown decision: " + decision)
    except Exception as e:
        toast.type = "error"
        toast.content = "处理失败：" + str(e)[:100]
        print("card action error:", e, flush=True)
    resp.toast = toast
    return resp


def main():
    app_id, app_secret = load_creds()
    handler = (lark.EventDispatcherHandler.builder("", "")
               .register_p2_customized_event(EVENT_TYPE, on_bitable_changed)
               .register_p2_card_action_trigger(on_card_action)
               .build())
    cli = lark.ws.Client(app_id, app_secret, event_handler=handler,
                         log_level=lark.LogLevel.DEBUG)
    print("ws client starting for app", app_id, flush=True)
    cli.start()


if __name__ == "__main__":
    main()
