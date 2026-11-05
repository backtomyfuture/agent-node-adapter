#!/usr/bin/env python3
"""Agent 中台结果回注扫描器（枢纽侧，标准 v3）。

用法：
  present_results.py --list         输出未呈递的终态/待处理任务（JSON，每行一条），无则输出空
                                    每项含本次算好的 present_key、status、status_msg
  present_results.py --mark id1,id2 未传键时按当前行计算呈递键（兼容旧用法）
  present_results.py --mark <record_id> [present_key|status_msg]
  present_results.py --mark <record_id> --key <present_key>
  present_results.py --mark <record_id> --status-msg <msg>
                                    传入的是本次实际呈递的键：只把该键写入 Metadata，
                                    不重读表上可能已前进的状态
  present_results.py --sweep        与 --list 相同的未呈递清单（stdout），另在 stderr 告警陈旧 working

呈递范围（v3）：终态 completed/failed、需机主动作的 input-required/auth-required、
被拒收 rejected。
去重（标准 §8.5）：按 (Task_ID, Status_Msg)，不是按任务永久布尔。终态的 Status_Msg
经常被清空或仍指向上一条 question，所以终态键再带上 Status，记在
Metadata.presented_keys。Presented 只表示「当前这一态已呈递」，不能单独当去重依据。
同一任务出现新 question / auth_request，或续跑后进入 completed/failed，都会再次入队。
内容来源：该任务最新一条 result/question/auth_request/notice 消息（Messages 表）；
执行结果与报错取 Latest_Run 的 Outcome/Error_Log。
数据源：飞书多维表格中台 Base，经 lark-cli 以操作者用户身份读取
（与 hub_api.py 的 bot 身份读法等价，选此路是让呈递天然带操作者视角；
CLI 命令可用环境变量 LARK_CLI 覆盖，默认 PATH 上的 lark-cli）。
json 格式单次最多 200 行，list_table 按 --offset / next_offset（或 has_more）翻完。
"""
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone

from hub_api import BASE_TOKEN as BASE, MESSAGES, PARTS, RUNS, TASKS

CLI = shlex.split(os.environ.get("LARK_CLI", "lark-cli"))

PRESENT_STATUSES = {"completed", "failed", "input-required", "auth-required", "rejected"}
# 终态 Status_Msg 不可靠，去重键必须带上 Status，否则问答续跑后的结果会被旧键吞掉。
TERMINAL_STATUSES = {"completed", "failed", "rejected"}
MSG_KINDS = ("result", "question", "auth_request", "notice", "answer", "auth_decision")
PAGE_LIMIT = 200
# 与标准 §8.4、节点 STALE_MIN 对齐。枢纽只告警：节点只回收 Claimed_By 是自己的任务。
STALE_MIN = 20
_HB_OFF = re.compile(
    r"^(?P<head>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)(?P<sign>[+-])(?P<hh>\d{2})(?P<mm>\d{2})$")


def cli_json(args):
    out = subprocess.run(CLI + args, capture_output=True, text=True, timeout=120)
    raw = out.stdout
    i = raw.find("{")
    if i < 0:
        raise RuntimeError(f"lark-cli no json output: {raw[:200]} {out.stderr[:200]}")
    return json.loads(raw[i:])


def _page_rows(data):
    cols = data.get("fields") or []
    ids = data.get("record_id_list") or []
    matrix = data.get("data") or []
    rows = []
    for rid, row in zip(ids, matrix):
        m = dict(zip(cols, row))
        m["_record_id"] = rid
        rows.append(m)
    return rows


def list_table(table_id):
    """按 offset 翻页读全表。json 格式上限 200，截断的一页不能当作对账全集。"""
    rows = []
    offset = 0
    seen = set()
    pages = 0
    while True:
        if offset in seen:
            raise RuntimeError("pagination offset did not advance at %s" % offset)
        seen.add(offset)
        pages += 1
        if pages > 500:
            raise RuntimeError("pagination exceeded 500 pages for %s" % table_id)
        d = cli_json(["base", "+record-list", "--as", "user", "--base-token", BASE,
                      "--table-id", table_id, "--format", "json",
                      "--limit", str(PAGE_LIMIT), "--offset", str(offset)])
        data = d.get("data") if isinstance(d.get("data"), dict) else d
        page = _page_rows(data)
        rows.extend(page)
        has_more = data.get("has_more", d.get("has_more", False))
        if not has_more:
            break
        nxt = data.get("next_offset", d.get("next_offset"))
        if nxt is None:
            # 短页时不能用 limit 硬加，否则会跳行；与 CLI manifest 的算法一致。
            nxt = offset + len(page)
        nxt = int(nxt)
        if nxt <= offset or not page:
            raise RuntimeError("next_offset did not advance at %s" % offset)
        offset = nxt
    return rows


def sel(v):
    if isinstance(v, list):
        return v[0] if v else ""
    return v or ""


def load_meta(raw):
    """Metadata 是 JSON 文本。解析失败时不当作已呈递，避免坏数据把新结果永久吞掉。"""
    text = raw if isinstance(raw, str) else sel(raw)
    if not isinstance(text, str):
        return {}
    text = text.strip()
    if not text:
        return {}
    try:
        obj = json.loads(text)
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def present_key(task_id, status, status_msg):
    msg = status_msg or ""
    if status in TERMINAL_STATUSES:
        return "%s\t%s\t%s" % (task_id, status, msg)
    return "%s\t%s" % (task_id, msg)


def normalize_present_key(key):
    """JSON 文本里的 \\t 被原样粘进命令行时不是制表符。键只认真实制表符。"""
    if "\t" not in key and "\\t" in key:
        return key.replace("\\t", "\t")
    return key


def looks_like_present_key(token):
    return "\t" in token or "\\t" in token


def status_msg_of_key(key):
    parts = key.split("\t")
    if len(parts) >= 3:
        return "\t".join(parts[2:])
    if len(parts) == 2:
        return parts[1]
    return ""


def resolve_mark_key(task_id, status, status_msg, explicit_key=None, explicit_status_msg=None):
    """决定写入 presented_keys 的键，并返回表上当前态的键供对照。

    显式 present_key / status_msg 来自本次实际呈递（--list 当时的快照）。
    不能用表上可能已经前进的 Status 重算：中断态呈递期间若已变成 completed，
    重算会把尚未呈递的终态键提前标掉。未显式传入时才回退到当前行。
    只凭 Status_Msg 能唯一确定的是中断态键（不含 Status）；终态必须传完整 present_key。
    """
    current = present_key(task_id, status, status_msg or "")
    if explicit_key is not None:
        key = normalize_present_key(explicit_key)
        owner = key.split("\t", 1)[0]
        if owner != task_id:
            raise RuntimeError("present_key does not match task %s: %s" % (task_id, key))
        return key, current
    if explicit_status_msg is not None:
        return present_key(task_id, "", explicit_status_msg), current
    return current, current


def apply_presented(meta, key):
    """只把指定键写入 presented_keys。不根据表上最新状态另算一枚。"""
    keys = presented_keys(meta)
    if key not in keys:
        keys.append(key)
    meta["presented_keys"] = keys
    msg_ids = meta.get("presented_msg_ids") or []
    if not isinstance(msg_ids, list):
        msg_ids = []
    else:
        msg_ids = list(msg_ids)
    marked_msg = status_msg_of_key(key)
    if marked_msg and marked_msg not in msg_ids:
        msg_ids.append(marked_msg)
    meta["presented_msg_ids"] = msg_ids
    return meta


def presented_keys(meta):
    keys = meta.get("presented_keys") or []
    if isinstance(keys, str):
        return [keys]
    if isinstance(keys, list):
        return [k for k in keys if isinstance(k, str)]
    return []


def parse_heartbeat(value):
    """节点 Heartbeat_At 形如 2026-11-05T12:34:56+0800。空或无法解析视为没有心跳。"""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        sec = value / 1000.0 if abs(value) > 10_000_000_000 else float(value)
        return datetime.fromtimestamp(sec, timezone.utc)
    s = str(value).strip()
    if not s:
        return None
    m = _HB_OFF.match(s)
    if m:
        head = m.group("head").replace(" ", "T")
        if len(head) == 16:
            head += ":00"
        s = "%s%s%s:%s" % (head, m.group("sign"), m.group("hh"), m.group("mm"))
    else:
        s = s.replace(" ", "T", 1)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", s):
            s += ":00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def is_stale_working(heartbeat, now=None):
    ts = parse_heartbeat(heartbeat)
    if ts is None:
        return True
    if now is None:
        now = datetime.now(ts.tzinfo) if ts.tzinfo else datetime.now()
    elif ts.tzinfo is None and now.tzinfo is not None:
        ts = ts.replace(tzinfo=now.tzinfo)
    elif ts.tzinfo is not None and now.tzinfo is None:
        now = now.replace(tzinfo=ts.tzinfo)
    return (now - ts).total_seconds() > STALE_MIN * 60


def pending_items(tasks, runs, msgs, parts):
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
        task_id = sel(t.get("Task_ID"))
        status_msg = sel(t.get("Status_Msg")) or ""
        key = present_key(task_id, status, status_msg)
        if key in presented_keys(load_meta(t.get("Metadata"))):
            continue
        tmsgs = [m for m in msgs_by_task.get(task_id, []) if sel(m.get("Kind")) in MSG_KINDS]
        last_msg = tmsgs[-1] if tmsgs else {}
        run = runs_by_id.get(sel(t.get("Latest_Run"))) or (
            runs_by_task.get(task_id, [{}])[-1] if runs_by_task.get(task_id) else {})
        out.append({
            "record_id": t["_record_id"],
            "task_id": task_id,
            "title": sel(t.get("Title")),
            "status": status,
            "status_msg": status_msg,
            "present_key": key,
            "target": sel(t.get("Target_Node")),
            "msg_kind": sel(last_msg.get("Kind")),
            "msg_from": sel(last_msg.get("From_Node")),
            "message": "\n".join(text_by_parent.get(sel(last_msg.get("Msg_ID")), [])),
            "artifact_ref": sel(last_msg.get("Artifact_Ref")),
            "outcome": sel(run.get("Outcome")),
            "error": sel(run.get("Error_Log")),
        })
    return out


def stale_working_alerts(tasks, now=None):
    alerts = []
    for t in tasks:
        if sel(t.get("Status")) != "working":
            continue
        hb = sel(t.get("Heartbeat_At"))
        if not is_stale_working(hb, now=now):
            continue
        ts = parse_heartbeat(hb)
        age_min = ""
        if ts is not None:
            ref = now or (datetime.now(ts.tzinfo) if ts.tzinfo else datetime.now())
            if ts.tzinfo is None and getattr(ref, "tzinfo", None) is not None:
                ts = ts.replace(tzinfo=ref.tzinfo)
            elif ts.tzinfo is not None and getattr(ref, "tzinfo", None) is None:
                ref = ref.replace(tzinfo=ts.tzinfo)
            age_min = str(int((ref - ts).total_seconds() // 60))
        alerts.append({
            "task_id": sel(t.get("Task_ID")),
            "record_id": t["_record_id"],
            "heartbeat_at": hb or "",
            "age_min": age_min,
        })
    return alerts


MARK_USAGE = (
    "usage: present_results.py --mark id1,id2\n"
    "       present_results.py --mark <record_id> [present_key|status_msg]\n"
    "       present_results.py --mark <record_id> --key <present_key>\n"
    "       present_results.py --mark <record_id> --status-msg <msg>")


def parse_mark_argv(argv):
    """解析 --mark 之后的参数。显式键只作用于一个 record_id。"""
    if not argv:
        raise SystemExit(MARK_USAGE)
    positional = []
    explicit_key = None
    explicit_status_msg = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--key":
            if explicit_key is not None or i + 1 >= len(argv):
                raise SystemExit(MARK_USAGE)
            explicit_key = argv[i + 1]
            i += 2
            continue
        if a == "--status-msg":
            if explicit_status_msg is not None or i + 1 >= len(argv):
                raise SystemExit(MARK_USAGE)
            explicit_status_msg = argv[i + 1]
            i += 2
            continue
        if a.startswith("--"):
            raise SystemExit(MARK_USAGE)
        positional.append(a)
        i += 1
    if not positional or len(positional) > 2:
        raise SystemExit(MARK_USAGE)
    ids = [x for x in positional[0].split(",") if x]
    if not ids:
        raise SystemExit(MARK_USAGE)
    if len(positional) == 2:
        token = positional[1]
        if looks_like_present_key(token):
            if explicit_key is not None:
                raise SystemExit(MARK_USAGE)
            explicit_key = token
        else:
            if explicit_status_msg is not None:
                raise SystemExit(MARK_USAGE)
            explicit_status_msg = token
    if explicit_key is not None and explicit_status_msg is not None:
        raise SystemExit(MARK_USAGE)
    if (explicit_key is not None or explicit_status_msg is not None) and len(ids) != 1:
        raise SystemExit(MARK_USAGE)
    return ids, explicit_key, explicit_status_msg


def mark(ids, explicit_key=None, explicit_status_msg=None):
    tasks = {t["_record_id"]: t for t in list_table(TASKS)}
    for rid in ids:
        t = tasks.get(rid)
        if not t:
            raise RuntimeError("record not found: " + rid)
        meta = load_meta(t.get("Metadata"))
        task_id = sel(t.get("Task_ID"))
        status = sel(t.get("Status"))
        status_msg = sel(t.get("Status_Msg")) or ""
        key, current = resolve_mark_key(
            task_id, status, status_msg, explicit_key, explicit_status_msg)
        meta = apply_presented(meta, key)
        # Presented 只表示「当前态已呈递」。指定键与当前态不一致时（呈递期间已流转），
        # 不能把 Presented 打成 Yes，也不能把当前态的键写进去。
        fields = {"Metadata": json.dumps(meta, ensure_ascii=False)}
        if key == current:
            fields["Presented"] = ["Yes"]
        cli_json(["base", "+record-upsert", "--as", "user", "--base-token", BASE,
                  "--table-id", TASKS, "--record-id", rid, "--json",
                  json.dumps(fields, ensure_ascii=False)])
    print(f"marked {len(ids)}")


def main():
    cmd = sys.argv[1] if len(sys.argv) >= 2 else "--list"
    if cmd == "--mark":
        ids, explicit_key, explicit_status_msg = parse_mark_argv(sys.argv[2:])
        mark(ids, explicit_key, explicit_status_msg)
        return
    if cmd not in ("--list", "--sweep"):
        raise SystemExit(
            "usage: present_results.py --list | --mark id1,id2 | "
            "--mark <record_id> [--key <present_key> | --status-msg <msg>] | --sweep")
    tasks = list_table(TASKS)
    runs = list_table(RUNS)
    msgs = list_table(MESSAGES)
    parts = list_table(PARTS)
    if cmd == "--sweep":
        # 告警走 stderr，stdout 保持与 --list 相同的 JSONL，方便接进呈递队列。
        for a in stale_working_alerts(tasks):
            print("WARN stale-working task_id=%s record_id=%s heartbeat_at=%s age_min=%s"
                  % (a["task_id"], a["record_id"], a["heartbeat_at"] or "-", a["age_min"] or "-"),
                  file=sys.stderr)
    for item in pending_items(tasks, runs, msgs, parts):
        print(json.dumps(item, ensure_ascii=False))


if __name__ == "__main__":
    main()
