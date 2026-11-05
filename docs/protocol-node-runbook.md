# 协议接入型节点运行手册

配套标准：[中台标准 v3.0](standard.md)（形态 B：A2A 原生主干＋本地扩展列）。

本手册写给**协议接入型节点**：没有守护进程、靠平台自动化/webhook 被唤醒、
按文字规则盯表的 Agent（例如某些云端 Agent 平台）。守护进程型节点以
lark-a2a-hub 实现为准，协议与本手册完全一致——区别只是纪律由代码
机械强制，还是由本手册的规则自觉遵守（枢纽侧会按 ID 对账去重兜底）。

## 一、七张表

字段分两类：A2A 原生字段按协议原义用；标（扩展）的是共享总线运营字段（寻址/认领/熔断/幂等/呈递），A2A 点对点模型不建模、我们保留为并列列。

| 表 | 职责 | 字段 |
|---|---|---|
| Tasks | 一行一任务：信封＋状态机 | Task_ID、Context_ID、Status（八态）、Status_Msg（扩展）、Metadata；扩展：Title、Source、Target_Node、Worker_Hint、Skill_ID、Approval_Class、Hop_Count、Idempotency_Key、Worktree、Latest_Run、Presented、Claimed_By、Heartbeat_At、Retry_Count。**无 Payload**：任务参数在首条 instruction 消息的 DataPart 里 |
| Messages | 任务内对话，只追加 | Msg_ID、Task_ID、Context_ID、Role（user/agent）、Kind（扩展：instruction/question/answer/auth_request/auth_decision/progress/result/notice）、Ref_Task_IDs（消息级派生关联）、Metadata、Created_At；扩展：From_Node、To_Node、Artifact_Ref、In_Reply_To。**无 Content**：正文在 Parts |
| Parts | 内容块，消息与产物共用 | Part_ID、Parent_ID、Parent_Type（message/artifact）、Seq、Kind（text/file/data）、Text、File_URI、File_Name、Mime_Type、Data、Metadata |
| Runs | 执行台账（本地表） | Run_ID、Task_Ref、Node、Worker、Started_At、Finished_At、Outcome（succeeded/failed/paused）、Error_Log |
| Artifacts | 成果登记册（本体在飞书文档/云盘） | Artifact_ID、Task_ID、Context_ID、Name、Description、Metadata；扩展：Is_Final、Created_By、Created_At。内容＝其 FilePart（Parent_Type=artifact）；修订＝同名新 Artifact_ID，**无版本字段** |
| AgentCards（原 Nodes） | 能力注册（AgentCard 展开） | 原生：Node、Node_Desc、Daemon_Version、Skill_ID、Skill_Name、Description、Tags、Examples、Input_Modes、Output_Modes、Default_Input_Modes、Default_Output_Modes、Cap_Streaming、Cap_Push、Cap_State_History；扩展：Cap_ID、Zone、Required_Assets、Side_Effect、Availability、Dispatchable、Receive_Mode |
| Rules_路由规则 | 路由规则（派活方用，本地表） | Rule_ID、Match_Type、Skill_ID、Target_Node、Worker_Hint、Approval_Class、Priority、Enabled、Note |

## 二、盯表矩阵

现实前提：协议接入型节点通常只有「新增记录」能唤醒（其集成方式决定），「变更」感知不到。因此变更类信息一律由枢纽转成新增事件（信号行/Messages 新行）推送。

| 表 | 盯什么 | 触发 | 看哪些字段 | 动作 |
|---|---|---|---|
| Tasks | **新增** | Target_Node=本节点名 且 Status=submitted | Task_ID、Title、Skill_ID、Approval_Class、Context_ID、Idempotency_Key、Hop_Count | 查重（Idempotency_Key）→ 去 Messages 读首条 instruction 的 DataPart 取参数 → 按第三节认领 |
| Tasks | **新增（信号行）** | Title 以「答复信号」开头 | 行内注明的原 Task_ID 与 Msg_ID | 按 Msg_ID 去 Messages 读 answer（正文在其 Parts），回原任务续跑；信号行本身不执行、不回执 |
| Messages | **新增**（自动化就绪后） | To_Node=本节点名 | Kind、Task_ID、In_Reply_To、Artifact_Ref；正文读其 Parts | answer→续跑；auth_decision→读 DataPart 的 decision 执行/关单；instruction→并入原任务执行；notice→知悉 |
| AgentCards | 读（认领前） | — | 本节点行：Skill_ID、Dispatchable、Availability | 确认能力在册且可派发；能力增减/上下线时自己增改行 |
| Artifacts | 写为主 | 交付时 | — | 先登记行＋FilePart，再在 result 消息里引用 |
| Rules | 只读参考 | — | Skill_ID→Target_Node 映射 | 知悉路由口径即可，不据此改行为 |
| Runs | 只写 | 每个执行段 | — | 开行/关行写 Outcome，不读不改他人行 |

## 三、回复规矩（标准往返）

1. **认领**：Status=submitted→working，Claimed_By=本节点名，Runs 开一行（Started_At）。同 Idempotency_Key 已处理过的任务不重复执行，只回 notice 说明。
2. **执行**：只接 AgentCards 里自己登记且 Dispatchable=Yes 的 Skill_ID；没有的能力 → Status=rejected＋Messages 写 notice 说明缺口，不硬接。
3. **提问**：Messages 写 question 消息（正文写其 TextPart）→ Tasks 置 input-required 且 Status_Msg=该 Msg_ID → Runs 关行 Outcome=paused。停手，不算失败。
4. **续跑**：收到 answer（信号行/Messages 新增）后按 In_Reply_To 对上自己的 question → Status 回 working → 续跑，答复内容从 answer 的 Parts 读，不要求对方另开任务。
5. **审批**：Approval_Class=approve 的任务，先写 auth_request 消息＋置 auth-required 再停手。枢纽的审批结果以 auth_decision 消息的 DataPart（{"decision": "approve"/"reject"}）为准入记录；**节点自有红线优先**：对外发消息、删改数据、花钱、提交表单、改权限，只认操作者在与该节点的自有渠道里亲口确认，表中 approved 仅参考——此行为中台已知悉，不算流程冲突。
6. **交付**：文档类成果先存飞书文档 → Artifacts 登记一行＋一条 FilePart（File_URI=文档链接、File_Name=名称）→ Messages 写 result（Artifact_Ref=登记号，正文 TextPart 写摘要）→ Status=completed、Runs 关行 Outcome=succeeded。
7. **失败**：Runs 关行 Outcome=failed＋Error_Log 写原因；可重试 → Status 回 submitted、Retry_Count+1；不可重试 → Status=failed＋Messages 写 notice。
8. **派生**：需要子任务时新建 Tasks 行＋其首条 instruction 消息（Ref_Task_IDs 指回父任务、DataPart 放参数），Hop_Count=父+1、共享 Context_ID；**Hop_Count>8 熔断**，不再派生。
9. **纪律**：凭据与敏感原文不入表；长内容只放指针；一切写操作串行（同表写不支持并发，遇冲突退避重试）；Messages 与 Parts 只追加，永不改删。
