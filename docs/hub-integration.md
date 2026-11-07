# 枢纽（hub）对接

枢纽是中台的操作者侧：负责把意图变成任务、把结果带回操作者。它不是
一个独立进程，而是一个**逻辑角色**（标准 §10.1）。实现是 Node 版
`hub-node daemon --role node|hub`（代码在 `src/hub/`）。省略 `--role` 时
读该配置目录 `node.json` 的 `role`，缺省 node。一台机器要同时承担 hub
与 node，起两个守护进程、各用一个配置目录（--config）。本篇是对接规范。

## 职责清单

1. **建单与路由**：按 Rules 表与 AgentCards 选目标节点与技能，生成
   Task_ID / Context_ID / Idempotency_Key 并建单（纪律见下；入口为
   `hub-node task create`，目标节点与技能由调用方指定。Rules 自动路由仍为计划）。
2. **唤醒与事件接收**：强制以 ws（hub 应用长连接订阅 Base 的记录变更事件
   `drive.file.bitable_record_changed_v1`，并注册 `card.action.trigger`）
   唤醒——审批卡回调只能经长连接送达，不允许纯轮询；对账周期默认 15 分钟
   （`sweepSec`）。事件只当门铃，内容回表读取，并驱动呈递与审批回调。
3. **结果呈递**：把终态、待答（input-required）、待批（auth-required）
   与拒收（rejected）及时带回操作者。去重按 (Task_ID, Status_Msg)
   （终态再带上 Status），已呈递键记在配置目录 `present_state.json`；
   Tasks.Metadata 里已有的 `presented_keys` 也认。Presented 只表示
   当前这一态是否已呈递，不能单独当永久去重。
4. **审批中继**：扫到 auth-required 就发审批卡；回调必须先确认
   操作者是机主，再把决定落成 auth_decision 并流转状态（标准 §8.3）。
5. **取消**：canceled 只由发起方或 hub 角色写入（审批驳回、代发起方
   落表取消请求）；node 角色不写。
6. **答复与续派**：操作者的答复写成 answer 消息追加到原任务；派生
   任务由枢纽或节点按熔断规则创建。
7. **对账与告警**：周期性扫表核对状态（漏呈补呈、重复回执按 ID 去重、
   陈旧任务告警），是事件直达之外的安全网。
8. **出站通知配置**：对协议接入型节点（Receive_Mode=automation），在 Base
   配置飞书自动化——Tasks 行新增或变更时向节点地址 POST，只带 ID。POST
   由飞书自动化发起，枢纽进程不主动推送。

**角色边界**：auth_decision 与 canceled 只能由 hub 角色的代码路径写入；
node 角色从不写这两样，hub 角色是唯一写方。

## 应用拓扑

- **默认：两个应用，身份隔离。** hub 角色一个自建应用，负责枢纽侧全部
  读写、事件长连接与审批卡发送；需开多维表格权限，并把该应用加为 Base
  编辑者；发卡另需 im 发消息权限。守护进程型节点一台机器一个应用。
  若该机已有 lark-cli 在用某个应用，也可让节点复用它（`hub-node setup`
  的默认路径）。
- **简化：hub 与 node 共用一个应用。** 适合单机部署或试用。代价：
  平台层面 hub 与 node 是同一身份，审计日志分不清谁写的；权限按并集开，
  node 也持有发消息权限；拿到这台机器凭据即可以同一身份写出
  From_Node=hub 的 auth_decision；停用该应用会同时停掉 hub 与 node
  （标准 §10.2）。
- **协议接入型节点**：用其自有平台的身份与自动化，不单独建应用。

## 传输方式

| 方式 | 机制 | 适用 |
|---|---|---|
| ws | 飞书 SDK 长连接事件订阅，出站连接，事件只当门铃 | hub 角色强制使用；守护进程型节点 |
| poll | 定时扫表，默认 45 秒 | 守护进程型节点无法订阅事件时 |
| webhook | 飞书自动化在 Tasks 行写入后 POST 对方端点，只带 ID | 协议接入型节点 |

三种方式都保留低频对账扫表兜底（默认 15 分钟）。webhook 的发起方是飞书
自动化：端点由协议接入型节点自有平台托管，本项目任何进程都不开监听
端口、也不主动推送。

## 事件订阅注册（最容易踩的一步）

- 适用于 ws 方式。接收走**长连接**（官方 SDK 的 WebSocket 客户端），
  是出站连接，不需要公网地址。
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
3. **审批类**：Approval_Class=approve 的任务，节点在认领前（仍为
   submitted）写 auth_request 并置 auth-required，不经 working。枢纽
   不要绕过审批直接改状态放行——决定必须以 auth_decision 消息落表，
   且 In_Reply_To 等于该任务当前 Status_Msg。
4. **信号行（过渡手段）**：对只能被「Tasks 新增」唤醒的 automation 型
   节点，answer 需双写一条轻量 Tasks 信号行（标题注明「答复信号」、
   指向原 Task_ID 与 Msg_ID）仅作唤醒；信号行不承载内容、接收方勿当
   新任务执行。对方的 Messages 自动化就绪后停用。

## 呈递

`hub-node daemon --role hub` 在对账周期里扫全表 Tasks（长连接事件只是提前叫醒）：

- 要呈递的状态：completed、failed、rejected、input-required、auth-required。
- 去重键不是「一个任务只呈递一次」：中断态是 (Task_ID, Status_Msg)；终态的
  Status_Msg 常被清空或仍指向旧 question，键再带上 Status。因此 question /
  auth_request 续跑后的新提问，以及最终 completed / failed，都会再发一次。
- 已发送的键写在配置目录 `present_state.json`（不进仓库，不回写 Tasks）。
  Tasks.Metadata 里已有的 `presented_keys` 同样视为已呈递。
- 正文直接发到机主私聊。未配置机主 open_id 则本轮跳过。没有队列文件。
- 陈旧告警与呈递分开：working 心跳为空、无法解析或早于 20 分钟，以及
  submitted 超过 20 分钟仍无人认领，每种情况每个任务只告警一次，记在
  `stale_state.json`。只通知机主，不替节点回收租约。

## 审批回路

1. 对账扫到 Status=auth-required，且配置目录 `approval_state.json` 里还没有
   这张卡，就用 hub 应用给机主发交互卡片。未配置机主 open_id 则不发卡，
   进程不退出。按钮 value 携带 `{decision, record_id, task_id, status_msg}`。
   每成功发送一张就立刻落盘，中途失败不会让已发出的卡在下一轮整批重发。
2. 机主点击 → `card.action.trigger` 进同一进程：先比对操作者 open_id 与
   机主（`node.json` 的 `ownerOpenId`，或环境变量 `HUB_OWNER_OPEN_ID`）。
   未配置机主、或操作者不是机主：拒绝，不写 auth_decision，不改任务状态。
   卡片只发给机主不能代替这一步。通过后回读任务，确认仍为 auth-required
   且 Status_Msg 与卡片上的一致 → 写 auth_decision（From_Node=hub、Role=user、
   In_Reply_To=当前 Status_Msg；DataPart 写
   `{"decision": "approve"|"reject"}`）→ approve 回置 submitted，
   **保留 Status_Msg 不清**（节点认领前用它核对 In_Reply_To），并清
   Presented 以便最终结果再呈递一次；reject 置 canceled，并写 notice。
3. 节点在下一轮唤醒时只认满足标准 §8.3 的 auth_decision——**表中任何
   「已批准」标记都不算数，只认这条消息**。

## 协议接入型节点的唤醒

按对方平台能力三选一（详见 [协议节点运行手册](protocol-node-runbook.md)）。
webhook 通知由飞书自动化发出：端点由对方平台托管，本项目不开监听端口、
也不主动推送；对方仍须按手册定期回表对账。

- 飞书自动化（Receive_Mode=automation）：Base 里建自动化「Tasks 行新增或
  变更 → POST 其 webhook（只带 ID）」；Messages 自动化就绪后同样可配
  （Messages 新增且 To_Node=该节点 → POST 其 webhook）。节点收到后经 REST
  读表处理。典型例子：Grok bot 这类无法建立长连接、但有固定接收地址的
  外部节点。凭据（webhook 地址与授权头）由操作者
  在平台间手工传递，不经表格。
- 信号行双写：见建单纪律第 4 条。

## 运维要点

- **进程托管**：用 `hub-node service --role hub` 注册用户级 launchd / systemd。
  长连接断开且 SDK 不再重连时，进程退避后只重建一条连接，不退化为纯轮询。
- **本地状态**：`approval_state.json`、`present_state.json`、`stale_state.json`
  写在配置目录，不进仓库。
- **归档轮换**：单表 2 万条上限；终态任务与 Runs 定期迁归档 Base 或
  导出后删除，规则与窗口由操作者定。
- **留痕**：排查看守护进程日志。事件只当门铃，不另写事件原文队列。
