#!/usr/bin/env python3
"""Agent 中台 · 枢纽 API 小工具（枢纽应用 bot 身份，凭据读 hub.env）。

配置走环境变量（照 docs/base-schema.md 建好 Base 后填）：
  HUB_BASE_TOKEN       中台 Base 的 token
  HUB_TASKS_TABLE / HUB_RUNS_TABLE / HUB_MESSAGES_TABLE / HUB_PARTS_TABLE /
  HUB_AGENTCARDS_TABLE 五张常用表的 table_id
  HUB_OWNER_OPEN_ID    操作者的飞书 open_id（审批卡的发送目标）
  HUB_ENV_FILE         凭据文件路径（默认与本文件同目录的 hub.env，
                       内容为 APP_ID= / APP_SECRET= 两行，权限 600）
"""
import json
import os
import time
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
BASE_TOKEN = os.environ.get("HUB_BASE_TOKEN", "<your-base-token>")
TASKS = os.environ.get("HUB_TASKS_TABLE", "<tasks-table-id>")
RUNS = os.environ.get("HUB_RUNS_TABLE", "<runs-table-id>")
MESSAGES = os.environ.get("HUB_MESSAGES_TABLE", "<messages-table-id>")
PARTS = os.environ.get("HUB_PARTS_TABLE", "<parts-table-id>")
NODES = os.environ.get("HUB_AGENTCARDS_TABLE", "<agentcards-table-id>")
API = "https://open.feishu.cn/open-apis"
ENV = os.environ.get("HUB_ENV_FILE", os.path.join(_HERE, "hub.env"))
USER_OPEN_ID = os.environ.get("HUB_OWNER_OPEN_ID", "")

_tok = {"v": None, "exp": 0}


def tenant_token():
    if _tok["v"] and time.time() < _tok["exp"] - 120:
        return _tok["v"]
    kv = {}
    with open(ENV) as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                kv[k] = v
    body = json.dumps({"app_id": kv["APP_ID"], "app_secret": kv["APP_SECRET"]}).encode()
    req = urllib.request.Request(API + "/auth/v3/tenant_access_token/internal",
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if d.get("code") != 0:
        raise RuntimeError("tenant token failed: " + str(d.get("msg")))
    _tok["v"] = d["tenant_access_token"]
    _tok["exp"] = time.time() + d.get("expire", 7200)
    return _tok["v"]


def api(method, path, payload=None, params=""):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path + params, data=data, method=method, headers={
        "Authorization": "Bearer " + tenant_token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    if d.get("code") != 0:
        raise RuntimeError("api %s: %s" % (d.get("code"), d.get("msg")))
    return d["data"]


def list_records(table):
    items, page = [], None
    while True:
        p = "&page_token=" + page if page else ""
        d = api("GET", "/bitable/v1/apps/%s/tables/%s/records" % (BASE_TOKEN, table),
                params="?page_size=100" + p)
        items.extend(d.get("items", []))
        if d.get("has_more"):
            page = d["page_token"]
        else:
            return items


def update_record(table, record_id, fields):
    return api("PUT", "/bitable/v1/apps/%s/tables/%s/records/%s" % (BASE_TOKEN, table, record_id),
               {"fields": fields})


def f1(rec, name):
    v = rec["fields"].get(name)
    if isinstance(v, list):
        return v[0] if v else ""
    return v if v is not None else ""


def send_card(open_id, card):
    return api("POST", "/im/v1/messages", {
        "receive_id": open_id, "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False)},
        params="?receive_id_type=open_id")
