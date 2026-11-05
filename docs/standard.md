# 多 Agent 中台标准（A2A 数据模型版，v3.0 形态 B）

> 现行标准，版本 v3.0。来源：A2A（Agent2Agent）协议 v1.0 数据模型
> （Google 牵头、Linux Foundation 托管）＋生产实测经验汇总。
> 表结构见 [Base 结构](base-schema.md)；系统设计见 [架构](architecture.md)。

## 0. 总原则

1. **借 A2A 的数据模型，不借它的通信方式**：不要求每个 Agent 对外开 HTTP 接口互调；飞书多维表格本身就是共用的消息总线，节点出站读写表即完成通信。
2. **三层分离**（v2 的核心修正）：沟通归 Messages、状态与成果归 Tasks/Artifacts、执行细节归 Runs。任何一层不许再兼另一层的职。
3. **只出不进**：节点只发起出站连接（飞书 API/长连接/自动化），不开监听端口、不做端口映射与反向隧道、不暴露所在局域网。
4. **机主审批红线**：涉及对外发消息、删改数据、花钱、提交表单、改权限的动作，最终只认机主本人在聊天里的亲口确认；表中标记仅作参考（auth-required 流程见 §8.3）。
5. **凭据与敏感原文不入表、不进载荷**；结果回传统一「摘要＋指针」。

## 1. 对象总览（七表，形态 B：A2A 主干＋本地扩展列）

字段分两类：**A2A 原生**字段按协议原义使用；**本地扩展**字段是共享总线运营所必需、A2A 点对点模型不建模的部分（寻址、认领租约、熔断、幂等、呈递），在各表规范中以（扩展）标明。除此之外的本地需求一律进原生 Metadata 字段，不再新增列。

| 表 | 对应 A2A 对象 | 职责 |
|---|---|---|
| Tasks | Task | 一件工作的信封与状态机：一行一任务 |
| Messages | Message（挂在 Task.history 上） | 任务内全部对话轮次：只追加，一行一消息（正文在 Parts） |
| Parts（v3 新增） | Part | 消息与产物的内容块：一行一块，text/file/data 三型 |
| Runs | （A2A 不建模，本地表） | 每次执行的起止、结果、报错 |
| Artifacts | Artifact | 交付物登记：内容为其 FilePart，修订＝同名新 ID |
| AgentCards（原 Nodes_能力注册） | AgentCard（规范化展开） | 一行一项能力：节点、技能、名片元数据、接收方式 |
| Rules_路由规则 | （本地表） | 路由与审批策略的唯一现行来源，派活前先查 |

## 2. Tasks 规范

字段（在 v1 基础上变更的标 ★）：

- Task_ID：业务编号，唯一，人可读；发起方生成后不变。
- ★ Context_ID：会话键，**取代 Session_Handle**。同一件事的全部任务共享一个 Context_ID；任务内对话靠 Task_ID 定位，Context_ID 负责把「同一件事」的多个任务串起来。
- Status：状态机见下。
- ★ Status_Msg（扩展）：当前状态附带的消息指针（进入 input-required / auth-required 时，指向提问/待批的那条 Messages 的 Msg_ID）——A2A 中为 TaskStatus 内嵌 message，表形态以指针等价实现。
- ★ Metadata：A2A 原生自由字段（JSON）；非核心本地信息放这里，不再新增列。
- **任务参数不在 Tasks 上**（v3 删除 Payload）：初始指令与参数写首条 instruction 消息，其 DataPart（Kind=data）承载参数 JSON（A2A 原生形态）。
- （扩展）Target_Node / Worker_Hint / Skill_ID / Title / Source / Approval_Class / Hop_Count / Idempotency_Key / Worktree / Claimed_By / Heartbeat_At / Retry_Count / Latest_Run / Presented：总线运营字段，定义沿用 v1/v2（守护进程与呈递管线维护其中一部分）。
- 任务派生关联写 Messages.Ref_Task_IDs（v3 起 Tasks 侧删除该列，见 §3）。

### 状态机（A2A 八态）

`submitted → working → (completed | failed | canceled | rejected)`，中断态 `input-required`、`auth-required` 可与 working 多次往返。

| 状态 | 含义 | 进入条件 |
|---|---|---|
| submitted | 已建单未认领 | 建单初始态（代 v1 Pending） |
| working | 执行中 | 认领后（代 v1 Running） |
| input-required | 等发起方/机主补信息或答复 | 执行方在 Messages 写了 question 后置此态（代 v1 Blocked 的提问用法） |
| auth-required | 等机主批准 | approve 类任务执行前置此态（代 v1 Blocked 的审批用法与 Review） |
| completed | 完成 | 成果已登记 Artifacts 或在 result 消息中给出（代 v1 Done） |
| failed | 执行失败且不再重试 | （代 v1 Failed） |
| canceled | 发起方取消 | （代 v1 Cancelled；拼写从 A2A 用单 l） |
| rejected | 目标节点拒收（无能力/不合规） | 拒收须在 Messages 写 notice 说明原因 |

规则：
- **终态（completed/failed/canceled/rejected）不可变、不可重启**。终态后要继续做：同 Context_ID 新开任务，新任务首条消息的 Ref_Task_IDs 指回前任（A2A refinement 模式）。
- **中断态不是结束**：答复走 Messages 追加（§8.1），任务回 working，禁止为答一个问题新开任务。
- 状态变更必须与消息配套：进 input-required 必有 question 消息；进 auth-required 必有 auth_request 消息；进终态必有 result/notice 消息或 Artifact 登记。

## 3. Messages 规范（v2 新增表）

一行一条消息，只追加、永不修改删除。字段：

- Msg_ID：主键，发送方生成，全局唯一，**同时是幂等键**（重复投递靠它去重）。
- Task_ID：所属任务（必填）。
- Context_ID：冗余会话键，便于按会话整串读取。
- From_Node / To_Node：发送方与接收方节点名（To_Node 可为机主 hub 的逻辑名 `hub`，或广播 `all`——广播仅限 notice）。
- Role：`user`（发起方→执行方）/ `agent`（执行方→发起方），沿 A2A 两值语义。
- Kind：消息类型枚举：
  - `instruction` 指令/补充要求（user）
  - `question` 提问、请求补信息（agent）——发出后任务置 input-required
  - `answer` 答复（user）——任务回 working
  - `auth_request` 待批说明（agent）——发出后任务置 auth-required
  - `auth_decision` 批准/驳回的落表记录（hub）——批准后任务回 submitted/working（见 §8.3）
  - `progress` 进展通报（agent，不改状态）
  - `result` 结果交付（agent，配合 Artifacts 指针，随后任务置 completed）
  - `notice` 告知/拒收说明（双向）
- 正文不在 Messages 上（v3 删除 Content / Content_Type）：一条消息的内容＝其 Parts 行集合（见本节 Parts 规范）。读消息＝按 Parent_ID 取 Parts 按 Seq 拼接。
- Ref_Task_IDs：A2A 原生 referenceTaskIds——本消息关联/派生的前任 Task_ID 列表（refinement 在消息级表达）。
- Metadata：A2A 原生自由字段（JSON）。
- Artifact_Ref（扩展）：关联的 Artifact_ID（可空）。
- In_Reply_To（扩展）：所回复的 Msg_ID（可空），构成对话链。
- Created_At：发送时间。

### Parts 规范（v3 新增表）

一行一个内容块，消息与产物共用：

- Part_ID：`父ID-P序号`。
- Parent_ID / Parent_Type：所属消息 Msg_ID 或产物 Artifact_ID；类型 `message` / `artifact`。
- Seq：块顺序，从 1 递增。
- Kind：`text` / `file` / `data`（A2A TextPart / FilePart / DataPart）。
- Text：text 块正文（长内容只放指针，本体进飞书文档）。
- File_URI / File_Name / Mime_Type：file 块三要素。
- Data：data 块的 JSON（任务参数、审批决定 {"decision": "approve"} 等结构化内容走这里）。
- Metadata：块级自由字段。

唤醒语义：消息即唤醒信号。各节点按自己的接收方式消费「To_Node=本节点且未读」的消息：守护进程型节点由长连接事件唤醒（或轮询兜底，见 §9 附则）；automation 型节点由飞书自动化监听新增消息触发；枢纽（hub）由事件接收端＋呈递管线处理。节点本地保存已读水位（last-seen Msg_ID），表侧不设已读标记，避免多方写冲突。

## 4. Runs 规范（瘦身）

只记执行台账，**不再承担回执与回复正文**：

- Run_ID / Task_Ref / Node / Worker / Started_At / Finished_At：沿用。
- ★ Outcome：`succeeded` / `failed` / `paused`（paused＝本次执行段因等补信息而暂停，配合 input-required，不计失败）。
- Error_Log：失败信息。
- ~~Receipt~~：**删除**。resolve/ask/notice/later 的沟通语义由 Tasks 状态＋Messages 承担；执行方要说话，去 Messages 写。
- ~~Summary~~：**删除**。执行内部备注如需保留，写 Run 的 Error_Log 或本机日志，不进中台。
- 重试沿用 v1：失败且 Retry_Count<2 回 submitted 重认领。

## 5. Artifacts 规范（v2 新增表）

- Artifact_ID：任务内唯一即可，全局建议 `任务ID-A序号`。
- Task_ID / Context_ID：归属。
- Name：产物名。**同名再交付即新版本**（沿 A2A：修订=新 artifactId、同 name，版本谱系由登记顺序表达；v3 已删除 Version 列）。
- Description：产物一句话说明（A2A 原生）。
- Metadata：A2A 原生自由字段（JSON）。
- 内容不在本表（v3 删除 Type / Pointer）：产物的内容＝其 FilePart（Parent_Type=artifact，File_URI 放链接或路径、File_Name 放名称；大文件只放指针，不入库本体）。
- Is_Final（扩展）：是否终稿（Yes/No）。
- Created_By / Created_At（扩展）：登记方与时间。

## 6. AgentCards 规范（原 Nodes 表，v3 更名）

沿用「一行一项能力」的规范化结构（等价于把 AgentCard 的 skills[] 拆成行）。A2A 原生字段：

- Node（卡片 name 的节点部分）/ Node_Desc（卡片 description）/ Daemon_Version（卡片 version）。
- Skill_ID（skill.id）/ Skill_Name（skill.name）/ Description（skill.description，v3 由 Capability 改名）/ Tags / Examples / Input_Modes / Output_Modes（skill 级元数据）。
- Default_Input_Modes / Default_Output_Modes（卡片级默认模式）。
- Cap_Streaming / Cap_Push / Cap_State_History（卡片 capabilities 三开关；Cap_Push＝支持推送通知，相当于声明有 PushNotification 通道）。

本地扩展字段：Cap_ID（行主键）、Zone、Required_Assets、Side_Effect、Availability、Dispatchable、Receive_Mode（唤醒方式：`poll` 守护进程轮询 / `automation` 飞书自动化监听 / `webhook` / `event` 长连接事件）。

路由规则不变：只接自己登记且 Dispatchable=Yes 的能力；表外任务置 rejected＋notice 说明缺口。

## 7. Rules 规范

沿用 v1：Rule_ID、Match_Type、Skill_ID、Target_Node、Worker_Hint、Approval_Class、Priority、Enabled、Note。路由按 Skill_ID＋tags 匹配能力行（v2 起 Skill_ID 视为技能 id，与 Nodes.Skill_ID 对齐）。规则变更只改表。

## 8. 通信协议（标准往返）

### 8.1 一件多轮任务的标准时序

1. 发起方建单：Tasks 一行（submitted、Context_ID 新生成或沿用）＋Messages 一条 instruction（任务参数放该消息的 DataPart）。
2. 目标节点认领：Status=submitted→working，写 Claimed_By/心跳；Runs 开一行。
3. 执行中要补信息：Messages 写 question → Status=input-required（Status_Msg 指向该消息）。**到此执行方停手，不算失败。**
4. 发起方/机主答复：Messages 追加 answer（In_Reply_To=question 的 Msg_ID）→ Status 回 working，执行方续跑。**不许新开任务答问题。**
5. 交付：产物登记 Artifacts → Messages 写 result（Artifact_Ref 指向产物）→ Status=completed，Runs 关行（Outcome=succeeded）。
6. 失败：Runs 关行（Outcome=failed＋Error_Log）；未达重试上限回 submitted 重认领，达上限 Status=failed＋Messages 写 notice 说明。

### 8.2 派生与熔断

- 子任务 Hop_Count＝父任务＋1；**Hop_Count>8 熔断**（全局统一口径；各节点原有更严口径的归并须经其操作者确认后生效）。
- 派生任务共享 Context_ID，来源以首条 instruction 消息的 Ref_Task_IDs 注明（v3 起写消息级）。

### 8.3 审批（auth-required）

- Approval_Class=approve 的任务：执行方认领后先 Messages 写 auth_request → Status=auth-required，停手。
- 枢纽呈递审批卡给机主；机主点击（或在聊天里亲口确认）后，枢纽写 auth_decision 消息（决定值放其 DataPart：{"decision": "approve"}）并把 Status 置回 submitted（v3 起只认 auth_decision 消息，Payload 注入做法已废止）。
- **各节点的自有红线优先于表中标记**：如某些协议接入型节点对高风险动作只认操作者在其自有渠道里的亲口确认——中台把「派给该节点的 approve 类任务天然带其二次确认」当作已知行为，不视为流程冲突。
- 驳回：auth_decision 写明驳回 → Status=canceled。

### 8.4 幂等与并发

- 建单靠 Idempotency_Key、消息靠 Msg_ID、认领靠 Claimed_By＋心跳回收（20 分钟无心跳视为放弃）——沿 v1。
- 同表写接口不支持并发：一切写操作串行＋退避重试；Messages 只追加不修改，天然避开大半写冲突。

### 8.5 通知与呈递

**附则（automation 唤醒型节点，2026-11-04 P3 实测补充）**：某些 automation 型节点目前只有「Tasks 表新增记录」才能唤醒，Messages 新增唤不醒它。在 Messages 表自动化（新增记录→调其 webhook）就绪前，枢纽给这类节点的 answer 采取双写：Messages 写正文，另建一条轻量 Tasks 信号行（新任务形态、标题注明「答复信号」并指向 Msg_ID 与原 Task_ID）仅作唤醒，信号行不承载内容、接收方勿当新任务执行。自动化就绪后本附则自动失效。

- 通知只报「哪个任务、什么新状态、哪条新消息」，内容由接收方回表拉全量（沿 A2A Push 语义）。
- 对机主的呈递沿现行实现：事件直达（表变更事件→接收端→呈递队列→秒级唤醒呈递）为主，20 分钟兜底扫表为辅；input-required 与 auth-required 的新消息属于必须呈递项。

## 修订记录

**v3.0（2026-11-04 晚，机主选定形态 B：A2A 原生主干＋本地扩展列）**：在 v2.2 基础上完成 A2A 完全体对齐——新增 Parts 表（消息与产物的内容块，text/file/data 三型）；Tasks 删除 Payload（参数迁首条 instruction 的 DataPart）与 Tasks 级 Ref_Task_IDs（迁 Messages 级，原生 referenceTaskIds），新增原生 Metadata；Messages 删除 Content/Content_Type（正文全量走 Parts）；Artifacts 删除 Type/Pointer/Version（内容走 FilePart，修订＝同名新 ID），新增原生 Description/Metadata；Nodes 表更名 AgentCards，Capability 改名 Description，补齐名片字段（Skill_Name、Tags、Examples、Input_Modes、Output_Modes、Default_Input/Output_Modes、Cap_Streaming/Cap_Push/Cap_State_History），存量三行已回填。七项总线运营字段（Target_Node、认领租约 Claimed_By/Heartbeat_At、Hop_Count、Retry_Count、任务级 Idempotency_Key、Presented、Source 及同类）经缺口分析确认为 A2A 点对点模型不建模的部分，以本地扩展列形式保留并逐项标注；其余本地需求一律进 Metadata。代码全量同步：守护进程 worker-3.0.0、呈递管线（Parts 拼接正文）、审批卡（上下文展示）、审批回调（auth_decision 写 TextPart＋DataPart）。TASK-HUB-V2-CUTOVER-001 已关单，切换通知改发 TASK-HUB-V3-NOTICE-001。


---

## 9. 附则：执行层与传输层修订（表结构不变）

- **能力模型三层**：L1 确定性脚本技能、L2 专长技能（指定本地 Agent 执行指定 Skill）、L3 通用能力（Agent＋工具面）。守护进程为薄壳（worker-4.x）：不内嵌任何执行器，能力由节点本地 `commands.json` 的命令模板定义（脚本与 agent 调用同为模板，如 `agy --print {prompt}`），守护进程按配置自动登记 AgentCards；新增能力不改守护进程代码。
- **回执约定（agent 型模板）**：最终输出即摘要；产物用 `ARTIFACT: <路径或URL>` 行声明；提问用 ```agent-ask 代码块，守护进程据此置 input-required。
- **节点传输**：节点侧与枢纽侧统一为长连接事件推送。节点以专属应用长连接接收记录变更事件，落盘 events.log 作门铃，守护进程被唤醒后回表拉取处理；保留 15 分钟对账扫表兜底（事件断线不补发），events.log 不存在时自动退回轮询。注意：Base 的云文档事件订阅只能以用户身份注册、且用户令牌按应用签发，须在节点本机交互终端以该应用完成 `auth login`（含 docs:event:subscribe scope）后调 drive subscribe 接口。
