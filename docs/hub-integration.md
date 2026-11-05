# 枢纽（hub）对接

枢纽是中台的操作者侧：负责把意图变成任务、把结果带回操作者。它不是
一个常驻服务集合，而是一组职责；参考实现见 [hub/](../hub/) 目录，
本篇是与实现无关的对接规范。

## 职责清单

1. **建单与路由**：按 Rules 表与 AgentCards 选目标节点与技能，生成
   Task_ID / Context_ID / Idempotency_Key 并建单（纪律见下）。
2. **事件接收**：以枢纽应用的长连接订阅 Base 的记录变更事件
   （`drive.file.bitable_record_changed_v1`），落盘备查，并驱动呈递与
   审批回调。
3. **结果呈递**：把终态、待答（input-required）、待批（auth-required）
   与拒收（rejected）及时带回操作者，靠 Tasks.Presented 防重复。
4. **审批中继**：watcher 扫到 auth-required 就发审批卡；操作者的决定
   由回调落成 auth_decision 消息并流转状态（标准 §8.3）。
5. **答复与续派**：操作者的答复写成 answer 消息追加到原任务；派生
   任务由枢纽或节点按熔断规则创建。
6. **对账**：周期性扫表核对状态（漏呈补呈、重复回执按 ID 去重、陈旧
   任务告警），是事件直达之外的安全网。

## 应用拓扑

- **枢纽应用**：一个自建应用，负责枢纽侧全部读写、事件长连接与审批卡
  发送；需开多维表格权限，并把该应用加为 Base 编辑者；发卡另需 im
  发消息权限。
- **节点应用**：守护进程型节点一台机器一个应用（与枢纽分开，身份与
  审计清晰）；若该机已有 lark-cli 在用某个应用，也可共用同一应用作
  节点身份（`hub-node setup` 的默认路径），代价是身份不隔离。
- **协议接入型节点**：用其自有平台的身份与自动化，不单独建应用。

## 事件订阅注册（最容易踩的一步）

- 接收走**长连接**（官方 SDK 的 WebSocket 客户端），不需要公网地址。
- 但「订阅某个 Base 的云文档事件」这个注册动作**只能以用户身份完成**
  （应用身份调订阅接口会被拒），且用户令牌按应用签发：必须在节点/
  枢纽本机的交互终端里，以该应用完成 `lark-cli auth login`（带
  `docs:event:subscribe` scope），再调
  `POST /open-apis/drive/v1/files/{base_token}/subscribe?file_type=bitable`。
- 注册是一次性的：注册完成后，长连接用应用身份即可收事件。SSH 等
  非交互会话通常读不到本机钥匙串，这步只能在机器跟前办。
- 注意：公式字段的值变化不触发记录变更事件，状态字段一律用普通字段。

## 建单纪律

1. **先消息、后任务行**：先写 instruction 消息，再写它的 Parts（参数
   放 DataPart），**最后写 Tasks 行**——任务行就是触发信号，先建行会
   让节点抢跑、读到空参数。
2. **幂等**：同一业务意图复用同一 Idempotency_Key；节点与枢纽都按它
   查重。写请求中途断线≠没建成：先按幂等键回表确认，再决定是否重建。
3. **审批类**：Approval_Class=approve 的任务，节点认领后会先置
   auth-required 停手；枢纽不要绕过审批直接改状态放行——决定必须以
   auth_decision 消息落表。
4. **信号行（过渡手段）**：对只能被「Tasks 新增」唤醒的 automation 型
   节点，answer 需双写一条轻量 Tasks 信号行（标题注明「答复信号」、
   指向原 Task_ID 与 Msg_ID）仅作唤醒；信号行不承载内容、接收方勿当
   新任务执行。对方的 Messages 自动化就绪后停用。

## 呈递管线（参考实现）

```
表变更事件 → event_receiver（长连接，防抖数秒）
          → present_results --list 扫未呈递的可呈递状态
          → 写入 present_queue.jsonl（每行 {record_id, task_id}）
          → 任意消费者取走呈递 → present_results --mark 置 Presented=Yes
```

- 队列文件就是**呈递接缝**：消费者可以是操作者的聊天 Agent、一个
  webhook 转发器或一段脚本；枢纽实现不关心队列下游是谁。
- 事件通道之外保留周期扫表兜底（参考实现为 20 分钟）：捞事件丢失时
  的漏呈，并顺带做接收端自愈检查（见运维）。

## 审批回路（参考实现）

1. `approval_watcher.py` 周期扫 Tasks：Status=auth-required 且未发过
   卡（本地状态文件记 record_id）→ 用枢纽应用给操作者发交互卡片，
   按钮 value 携带 `{decision, record_id, task_id}`。
2. 操作者点击 → 卡片回调进 `event_receiver.py` 的 card-action 处理：
   校验任务仍为 auth-required → 写 auth_decision 消息（TextPart 写
   人话说明、DataPart 写 `{"decision": "approve"|"reject"}`）→
   approve 回置 submitted（并清 Presented 以便最终结果再呈递一次），
   reject 置 canceled → 回 toast 给操作者。
3. 节点在下一轮唤醒时读到 auth_decision 才继续——**表中任何「已批准」
   标记都不算数，只认这条消息**。

## 协议接入型节点的唤醒

按对方平台能力三选一（详见 [协议节点运行手册](protocol-node-runbook.md)）：

- 平台自动化：Base 里建自动化「Messages 新增且 To_Node=该节点 → POST
  其 webhook」；Tasks 新增同理。凭据（webhook 地址与授权头）由操作者
  在平台间手工传递，不经表格。
- webhook 直推：枢纽在写消息后主动 POST 对方端点（仅通知 ID，内容由
  对方回表拉取）。
- 信号行双写：见建单纪律第 4 条。

## 运维要点

- **接收端自愈**：长连接接收端是单点。参考实现的做法是把服务单元的
  副本放在持久存储里，由定时巡检（或开机 boot 检测）比对、缺失即
  重装——适用于宿主机会被整体替换/重装的环境；普通环境用常规的
  systemd/launchd 托管即可。
- **归档轮换**：单表 2 万条上限；终态任务与 Runs 定期迁归档 Base 或
  导出后删除，规则与窗口由操作者定。
- **留痕**：事件原文落盘（events.log JSONL）是排查「事件到底来没来」
  的第一证据，保留滚动窗口即可。
