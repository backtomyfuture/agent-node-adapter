#!/usr/bin/env python3
"""从一张活的中台 Base 生成 schema/base-schema.json 与 docs/base-schema.md。

用法（在本仓库根目录）：
  APP_ID=<hub应用> APP_SECRET=<...> HUB_BASE_TOKEN=<Base token> \
      python3 schema/generate_schema.py

生成的文档以线上字段为准——先改表、再跑本脚本、最后提交，避免文档与
实现漂移。表按名字发现（不依赖 table_id），字段类型与单选选项取自字段 API。
"""
import json
import os
import time
import urllib.request

API = "https://open.feishu.cn/open-apis"
BASE = os.environ["HUB_BASE_TOKEN"]
TABLES = [
    ("Tasks", "Task：一件工作的信封与状态机，一行一任务"),
    ("Messages", "Message：任务内全部对话轮次，只追加，一行一消息（正文在 Parts）"),
    ("Parts", "Part：消息与产物的内容块，一行一块，text/file/data 三型"),
    ("Runs", "（本地表）每次执行的起止、结果与报错"),
    ("Artifacts", "Artifact：交付物登记，内容为其 FilePart，修订＝同名新 ID"),
    ("AgentCards", "AgentCard 规范化展开：一行一项能力"),
    ("Rules_路由规则", "（本地表）路由与审批策略的唯一现行来源"),
]

# 字段说明（文档层语义；结构事实以线上字段为准，生成时合并）
NOTES = {
    "Tasks": {
        "Task_ID": "业务编号，唯一、人可读，发起方生成后不变",
        "Context_ID": "会话键（A2A contextId）：同一件事的全部任务共享",
        "Status": "A2A 八态状态机，见标准 §2；终态不可变",
        "Status_Msg": "（扩展）指向当前提问/待批消息的 Msg_ID",
        "Metadata": "A2A 原生自由字段（JSON）；非核心本地信息放这里，不新增列",
        "Target_Node": "（扩展）目标节点名，与 AgentCards.Node 对应",
        "Skill_ID": "（扩展）要调用的技能 id，与 AgentCards.Skill_ID 对应",
        "Approval_Class": "（扩展）auto / notify / approve，approve 类须走审批流（标准 §8.3）",
        "Hop_Count": "（扩展）派生层数，>8 熔断",
        "Idempotency_Key": "（扩展）建单幂等键：来源+业务键",
        "Claimed_By": "（扩展）认领租约：当前持有节点",
        "Heartbeat_At": "（扩展）认领心跳；20 分钟无心跳视为放弃、可回收",
        "Retry_Count": "（扩展）失败重试计数，上限 2",
        "Latest_Run": "（扩展）最新一条 Run 的 Run_ID",
        "Presented": "（扩展）结果是否已呈递给操作者（Yes/No）",
        "Source": "（扩展）任务来源：hub / cron / manual / agent-derived 等",
    },
    "Messages": {
        "Msg_ID": "主键，同时是幂等键（重复投递靠它去重）",
        "Kind": "instruction / question / answer / auth_request / auth_decision / progress / result / notice",
        "Role": "user（发起方→执行方）/ agent（执行方→发起方）",
        "Ref_Task_IDs": "A2A referenceTaskIds：本消息关联/派生的前任任务",
        "In_Reply_To": "（扩展）所回复消息的 Msg_ID，构成对话链",
        "Artifact_Ref": "（扩展）关联的 Artifact_ID（result 消息用）",
    },
    "Parts": {
        "Parent_ID": "所属消息 Msg_ID 或产物 Artifact_ID",
        "Parent_Type": "message / artifact",
        "Kind": "text / file / data（A2A TextPart / FilePart / DataPart）",
        "Data": "data 块的 JSON：任务参数、审批决定 {\"decision\": \"approve\"} 等走这里",
        "Text": "text 块正文；长内容只放指针，本体进飞书文档",
    },
    "Runs": {
        "Run_ID": "形如 <Task_ID>-R<序号>",
        "Outcome": "succeeded / failed / paused（paused＝等补信息暂停，不计失败）",
        "Error_Log": "失败信息；沟通内容不写这里，去 Messages",
    },
    "Artifacts": {
        "Artifact_ID": "建议 <Task_ID>-A<序号>",
        "Name": "产物名；同名再交付即新版本（修订＝同名新 ID）",
        "Is_Final": "（扩展）是否终稿（Yes/No）",
    },
    "AgentCards": {
        "Cap_ID": "（扩展）行主键：CAP-<节点前缀>-<技能>",
        "Node": "节点名（AgentCard name 的节点部分）",
        "Skill_ID": "技能 id（skill.id）",
        "Description": "技能说明（skill.description）",
        "Dispatchable": "（扩展）Yes 才可派发",
        "Availability": "（扩展）online / work-hours / offline 等在册状态",
        "Receive_Mode": "（扩展）唤醒方式：event / poll / automation / webhook",
        "Side_Effect": "（扩展）read / write / external，决定默认审批等级",
    },
    "Rules_路由规则": {
        "Match_Type": "按 Skill_ID 或标签匹配",
        "Enabled": "是否生效（Yes/No）",
        "Priority": "多规则命中时按优先级取一",
    },
}

_tok = {"v": None, "exp": 0}


def tenant_token():
    if _tok["v"] and time.time() < _tok["exp"] - 120:
        return _tok["v"]
    body = json.dumps({"app_id": os.environ["APP_ID"],
                       "app_secret": os.environ["APP_SECRET"]}).encode()
    req = urllib.request.Request(API + "/auth/v3/tenant_access_token/internal",
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if d.get("code") != 0:
        raise RuntimeError("tenant token failed: " + str(d.get("msg")))
    _tok["v"] = d["tenant_access_token"]
    _tok["exp"] = time.time() + d.get("expire", 7200)
    return _tok["v"]


def api(path, params=""):
    req = urllib.request.Request(API + path + params, headers={
        "Authorization": "Bearer " + tenant_token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    if d.get("code") != 0:
        raise RuntimeError("api %s: %s" % (d.get("code"), d.get("msg")))
    return d["data"]


def paged(path):
    items, page = [], None
    while True:
        p = "&page_token=" + page if page else ""
        d = api(path, params="?page_size=100" + p)
        items.extend(d.get("items", []))
        if d.get("has_more"):
            page = d["page_token"]
        else:
            return items


def main():
    by_name = {t["name"]: t["table_id"] for t in paged("/bitable/v1/apps/%s/tables" % BASE)}
    schema = {"name": "Agent Hub Base（飞书多维表格）",
              "generated_by": "schema/generate_schema.py",
              "note": "结构事实由线上 Base 字段 API 生成；字段语义见 docs/base-schema.md 与 docs/standard.md。",
              "tables": []}
    for name, role in TABLES:
        tid = by_name.get(name)
        if not tid:
            raise SystemExit("Base 里找不到表：%s（现有：%s）" % (name, ", ".join(by_name)))
        fields = []
        for f in paged("/bitable/v1/apps/%s/tables/%s/fields" % (BASE, tid)):
            entry = {"name": f["field_name"], "ui_type": f.get("ui_type", ""),
                     "type": f.get("type"), "primary": bool(f.get("is_primary"))}
            opts = (f.get("property") or {}).get("options") or []
            if opts:
                names = [o["name"] for o in opts]
                # 发布快照的清洗：略去一次性测试节点名与历史误写的小写选项（不写回 Base）
                if f["field_name"] == "Target_Node":
                    names = [n for n in names if n not in ("node-dev", "setuptest")]
                if f["field_name"] == "Presented":
                    names = [n for n in names if n != "no"]
                entry["options"] = names
            fields.append(entry)
        schema["tables"].append({"name": name, "role": role, "fields": fields})

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    with open(os.path.join(here, "base-schema.json"), "w") as fp:
        json.dump(schema, fp, ensure_ascii=False, indent=1)

    lines = ["# Base 结构（七表字段级）", "",
             "本文件由 `schema/generate_schema.py` 从一张运行中的 Base 生成：字段名、",
             "类型与单选选项均为线上事实（个别一次性测试值已略）；「说明」列为文档层语义，完整规范见",
             "[中台标准](standard.md)。照此结构在飞书多维表格里建表（或用字段 API",
             "批量创建），即可得到一张可用的中台 Base。", ""]
    for t in schema["tables"]:
        lines.append("## %s" % t["name"])
        lines.append("")
        lines.append(t["role"])
        lines.append("")
        lines.append("| 字段 | 类型 | 说明 |")
        lines.append("|---|---|---|")
        notes = NOTES.get(t["name"], {})
        for f in t["fields"]:
            desc = notes.get(f["name"], "")
            if f.get("options"):
                opt = "选项：" + " / ".join(f["options"])
                desc = (desc + "（" + opt + "）") if desc else opt
            if f["primary"]:
                desc = ("主字段。" + desc) if desc else "主字段"
            lines.append("| %s | %s | %s |" % (f["name"], f["ui_type"], desc))
        lines.append("")
    with open(os.path.join(root, "docs", "base-schema.md"), "w") as fp:
        fp.write("\n".join(lines))
    print("tables:", [(t["name"], len(t["fields"])) for t in schema["tables"]])


if __name__ == "__main__":
    main()
