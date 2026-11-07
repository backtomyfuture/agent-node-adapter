# Grok Bot 重配报告分诊（B01–B11）

日期：2026-11-07。核对基准：仓库 `main` `1308f51ccf83a15b7da3ad8df73cca2685d21e41`（`DAEMON_VERSION` = `node-0.5.0`）。外部报告：`/Users/jarod/Downloads/lark-a2a-hub-reconfig-report.md`，其行号与当前树基本一致，偏差在下文逐条注明。

本次只读。未改已有源码，未访问 `~/.hub-node`，未调用飞书 API，未打印凭据。B01–B05、B08–B10 用 `/tmp` 内存 fake Bus 与源码字面量复核（脚本已删除）。fake Bus 按 `schema/base-schema.json` 拒绝未知字段和非法单选；整笔 `update` 失败时不落任何字段。这与飞书「字段名不存在则该次写入失败」的一般行为一致，**该失败模式是推断，没有打真实 API**。报告里的现场行（`TASK-20261107-8a9174` 的 Runs 形态、重复 result、线上已有 `AgentCards.Metadata`）本次未回表，不作为证据。

工作区里另有未跟踪文件 `docs/reviews/2026-11-07-muse-chat-no-reply.md`，本次未读未改。

## 总表

| 编号 | 结论 | 严重度 | 主要影响 |
|---|---|---|---|
| B01 | 已确认 | P1 | 只影响 `kind=agent` 的 `lah inbox done/fail` |
| B02 | 已确认 | P1 | 同上，带 `--artifact` 时 |
| B03 | 已确认 | P2 | 同上，`lah inbox ask` |
| B04 | 已确认 | P1 | 同上；内核 outbox 路径没有这个问题 |
| B05 | 已确认 | P1 | 按发布 schema 新建 Base 后的 host / `kind=agent` 守护进程。协议节点手工登记可不写该列 |
| B06 | 已确认 | P2 | 任何没有 `lark-cli` 的 `lah doctor`，含协议节点与纯 poll |
| B07 | 部分成立 | P2 | 文档。过时句和同页矛盾都有，不是整篇作废 |
| B08 | 已确认 | P1 | `lah task create` 的自动选能力与显式 `--cap`。接收方若是守规矩的守护进程，不会认领 `Dispatchable=No` |
| B09 | 已确认 | P2 | 所有未带 `--context` 的 `--ref` 派生单 |
| B10 | 已确认 | P2 | `lah setup` 选第 3 项后的 node 角色守护进程。未跑交互向导 |
| B11 | 已确认现象；取舍见设计问题 B | P2 | `install.sh` 与 `lah setup` 的本机技能复制。共享 Base 不宜做自动清库 |

host 节点的 agent/json 收尾走 `src/kernel.mjs`（`Finished_At` / `Outcome` / FilePart / outbox），不走 `src/inbox.mjs`。协议节点（`Receive_Mode=automation`）不跑这段 inbox 代码，除非有人额外调用 `lah inbox`。

---

## B01 — Inbox 完单/失败写错 Runs 字段

**结论：已确认。P1。**

发布 schema 的 Runs 只有这些列（`schema/base-schema.json` 342–398 行，`docs/base-schema.md` 71–84 行，标准 §4 108–110 行）：

`Run_ID`、`Task_Ref`、`Node`、`Worker`、`Error_Log`、`Started_At`、`Finished_At`、`Outcome`（单选 `succeeded` / `failed` / `paused`）。

没有 `Status`，没有 `Ended_At`。

`src/inbox.mjs` 实际写入：

- `handleInboxDone` 182–186 行：`Status=completed`，`Outcome=<摘要全文>`，`Ended_At`。
- `handleInboxFail` 280–284 行：`Status=failed`，`Error_Log=<原因>`，`Ended_At`。不写 `Outcome`。

fake Bus（按发布 schema 拒写）：

- done 抛 `FieldNameNotFound:Runs.Status`。违规项还有 `OptionNotFound:Runs.Outcome="摘要全文"`、`FieldNameNotFound:Runs.Ended_At`。result 消息已经写成 1 条，Tasks 仍是 `working`。
- fail 同样抛 `FieldNameNotFound:Runs.Status`，另有 `Ended_At`。notice 已写成 1 条，Tasks 仍是 `working`。`Error_Log` 这个字段名本身合法。

顺序是先 Messages/Parts，再 Runs，最后才改 Tasks（149–196、254–294 行）。Runs 更新一整笔失败时，result/notice 已在表上，任务停在 `working`。报告描述的「result 已写、Tasks 仍 working」在这个失败模型下成立。

对照内核 agent/json 收尾（`src/kernel.mjs`）：

- `writeRun` 388–389 行、`ensureRun` 1008–1012 行：更新 `Finished_At`、`Outcome`（`succeeded` 或 `failed`）、`Error_Log`。
- `openRun` 442–455 行注释写明没有 Status 列，用 `Started_At` 且尚无 `Finished_At` 表示进行中。

**影响面：** 只有 inbox 完单/失败。host 的命令模式、协议节点自写台账（手册要求 `Outcome`）不受这几行代码影响。

**根因：** inbox 收尾按一套不存在的 Runs 列写，并把摘要塞进单选 `Outcome`。内核已经按标准 §4 关账。

**最小修法（不实现）：** done 更新 `Outcome=succeeded`、`Finished_At`，摘要留在 result 的 TextPart。fail 更新 `Outcome=failed`、`Finished_At`、`Error_Log`。删掉 `Status` 与 `Ended_At`。

附带语义，单独看：`inbox fail` 直接把 Tasks 置 `failed`，不按 `Retry_Count` 回 `submitted`。内核命令失败在 `MAX_RETRIES` 内会回到 `submitted`（1308–1314 行）。这是「本尊宣告终止」和「命令失败可重试」的差别。标准 §4 没有为 inbox fail 单开例外。倾向：字段必须改；是否重试先在标准 §10.4 写明「`inbox fail` 视为不可恢复」，再保持直接终态。缺重试本身不当成与写错列同级的缺陷。

---

## B02 — `--artifact` 没有 FilePart

**结论：已确认。P1。**

`handleInboxDone` 135–147 行只 `createRecord` Artifacts：`Artifact_ID`、`Task_ID`、`Name`、`Description`、`Metadata={"path": ...}`。没有 Parts 写入。

fake Bus 传入 `https://example.invalid/report.md`（未访问网络）：产物行存在，`artifactFileParts=[]`。相对 schema，产物行缺 `Context_ID`、`Is_Final`、`Created_By`、`Created_At`。路径只在 `Metadata.path`。

标准 §5 125 行与 §8.1 第 5 步：内容是 `Parent_Type=artifact` 的 file Part，`File_URI` / `File_Name` 有值。内核 `ensureArtifact` 986–998 行先登记产物（含 `Context_ID`、`Is_Final`、`Created_By`、`Created_At`），再 `createPart(..., "artifact", 1, "file", { fileUri, fileName })`。

**影响面：** inbox 的 `--artifact`。host 成功路径会写 FilePart。协议节点若按手册第三节第 6 条自己写 FilePart，不经过这个函数。

**根因：** inbox 把指针塞进产物 Metadata，没有按 §5 写 FilePart，也没补归属列。

**最小修法：** 对齐 `ensureArtifact` 的列与一块 file Part。`Metadata.path` 可以留下，不能代替 FilePart。

---

## B03 — ask 不把执行段按 paused 关账

**结论：已确认。P2。**

`handleInboxAsk` 202–241 行写 question、TextPart，并把 Tasks 改成 `input-required`。没有任何 Runs 读写。

fake Bus：提问后 Tasks 为 `input-required`，question 1 条，Runs 行与调用前相同（`Outcome` 与 `Finished_At` 仍空）。

标准 §8.1 第 3 步、§4 的 `paused`、手册第三节第 3 条：提问时当前 Run `Outcome=paused` 并写 `Finished_At`。内核 `NeedInput` 分支 1300–1305 行调用 `writeRun(task, "paused", ...)` 再改状态。

inbox 认领时内核 `openRun` 已经开过行（1256–1274 行保持 `working` 返回）。ask 不去关它。续跑时 `unfinishedRun` 看到没有 `Finished_At` 会复用同一行，提问边界在台账上消失。任务状态本身是对的。

**影响面：** `kind=agent` 的 ask。host 提问会关成 paused。协议节点按手册自行关账则不受影响。

**最小修法：** ask 在改 Tasks 之前，把 `Latest_Run` 更新为 `Outcome=paused`、`Finished_At`。续跑再开新 Run。与 B01 同一文件一起改。

---

## B04 — 部分提交失败后重试会再写一条 result

**结论：已确认。P1。**

`handleInboxDone` 每次调用都 `nextMsgSeq`（115–127、149–165 行）后新建 Msg_ID，不读本地 outbox，也不按已有 Msg_ID 跳过。129–199 行没有「计划 ID、写前落盘、只补缺」的路径。

两段 fake Bus：

1. 第一次在 Tasks 更新处注入失败（result 与 Parts 已写入），再调用一次：result 从 `MSG-B04-02` 变成 `MSG-B04-02` 与 `MSG-B04-03`，共 2 条。与报告的 `resultMessageCount=2` 一致（01 是种子 instruction）。
2. 按发布 schema 让 Runs 更新失败后再调用一次：两次都抛 `FieldNameNotFound:Runs.Status`，Tasks 仍 `working`，result 变成 2 条。因此 B01 的失败本身就会在重试时走出 B04，不需要另注入 Tasks 失败。

内核对照（884–1119 行）：`beginOutbox` 先把 `msgId` / `artId` / token 落盘；`ensurePlan` 复用已规划的 ID；`createPart` 339–343 行按 `Part_ID` 跳过已有块；`ensureResultMessage` 1032 行按 `Msg_ID` 跳过已有消息；`submitOutbox` 失败保留文件，下轮 `flushOutbox` 只补缺。标准 §4 116 行要求同一语义。inbox 没有这条路径。

带 `--artifact` 的重试：产物在改 Tasks 之前按「已有条数 + 1」编号（137–146 行）。B04 的失败点在更后面。顺着已复现的控制流，带产物的重试会再登记一条 Artifact。本次脚本的 B04 用例没有带 artifact，这句是控制流推论，不是另一次执行输出。

**影响面：** inbox done（fail 同样每次新编号，结构相同，本次脚本只对 done 做了重试）。host 走 outbox。协议节点不自动获得内核 outbox，要自己按 §4 补齐。

**根因：** inbox 把「一次 CLI 调用」当成一次全新提交，ID 随当前行数重新分配。

**最小修法：** 只改 `src/inbox.mjs`。在第一笔总线写之前把 taskId、msgId、partId、artifactId、Run 更新字段写入配置目录 outbox（600）；重试时复用这些 ID，已存在的行跳过，只补 Runs 与 Tasks。不要为了复用去改 `src/kernel.mjs`，避免和别的改动抢文件。inbox 的 outbox 与内核 outbox 不要写成同一个文件格式，除非单独开任务抽取公共模块。

附带观察（不立项，未把内核 `submitOutbox` 跑进 fake Bus）：`ensureResultMessage` 1035 行把成功/无效回执的 `To_Node` 写成字面量 `"hub"`。标准 §0 第 7 条要求回执 `To_Node` 原路指向首条 instruction 的 `From_Node`。inbox 的 `initiatorOf` 反而是对齐标准的。这不影响 B04 的「ID 不复用」结论。

---

## B05 — 发布 schema 没有 AgentCards.Metadata，内核无条件写它

**结论：已确认。P1（打在按发布 schema 新建的 Base）。**

`Kernel.desiredCard` 681–684 行无条件带上：

```text
Metadata = JSON.stringify({ kind, mode })
```

用原型挂上最小 `cfg` 调用后，相对 `schema/base-schema.json` 的 AgentCards 列，`missingInPublishedSchema=["Metadata"]`。该表字段到 `Cap_State_History` 为止（465–652 行）。`docs/base-schema.md` 102–129 行同样没有这一行。Tasks / Messages / Parts / Artifacts 的 Metadata 都在。

标准 §6（129–140 行）的 AgentCards 清单也没有 Metadata。§0 第 19 行写「其余本地需求进原生 Metadata」，但 §6 的逐列合同没把这一列列进去。v3.0 修订记列举名片补齐字段时也没有它。所以这不是「标准已经要求、生成物落后」：现行 §6 与生成物一致，是代码超前于二者。

`reconcileCards` 700–703 行把 `desiredCard` 整包 `createRecord`。`sweepOnce` 1501–1507 行在名片登记抛错时不会把 `_capsReady` 置真，本轮不派发；`run` 1543–1547 行吞掉异常后下轮重试。按发布 schema 建的新 Base 上，host 与 `kind=agent` 守护进程会卡在「能力名片未登记」。协议节点不跑 `reconcileCards` 时，手工名片可以不写 Metadata。

`doctor` 166–167 行只检查 `node.json` 里有表 ID；239–248 行只读 AgentCards 与 Tasks 的行。没有字段完整性检查。报告写的 160–168、239–248 指的就是这件事，行号仍有效。

报告称当前线上 Base 已有该列、所以这次名片创建成功。**本次未核实线上列。** 若属实，现网登记可以成功，缺陷留在「照 `docs/base-schema.md` 新建的 Base」。

`docs/base-schema.md` 开头仍写由 `schema/generate_schema.py` 生成；仓库里的生成器是 `schema/generate_schema.mjs`。这只说明文档头过时，不改变「生成物不许手改」。

**影响面：** 新建 Base 上的 host 与 `kind=agent` 守护进程登记。已有列的现网（未核实）与纯手工协议名片可以不受影响。`src/hub/create.mjs` 163–164 行会读 Metadata 的 `kind` / `mode` 来给自动选能力加分，所以这一列一旦补上是有消费者的；`Skill_ID=agent` 即使没有 Metadata 也会得到 200 分。

**最小修法：** 先改标准 §6，把 `AgentCards.Metadata` 写成 A2A 原生自由字段，并在 CHANGELOG 记「表结构增加一列」。然后由人在线上 Base 加列，再跑 `schema/generate_schema.mjs`，提交生成的 `schema/base-schema.json` 与 `docs/base-schema.md`。内核不用改。doctor 的字段检查放到生成物更新之后再做，否则会把今天的发布 schema 判失败。

---

## B06 — 纯 REST / 协议节点缺 lark-cli 时 doctor 失败

**结论：已确认。P2。倾向：这是诊断门槛过严，值得改，不是协议缺陷。**

`src/doctor.mjs` 200–204 行：发现不了 `lark-cli` 就 `problems++`，然后 406–407 行有问题即退出码 1。这段不看 `events`、`kind`、`pollSec`。报告写的 195–205 行覆盖这段。

`src/setup.mjs` 784–792 行：已经有环境变量或 `app.env` 的 app id / secret 时，不会走进 `ensureLarkCli()`。setup 可以用应用凭据完成配置，doctor 仍会因为没有 CLI 失败。报告写的 784–795 行就是这个分支的开头。

335–337 行：`events` 为假时文案固定是「轮询（poll）${pollSec}s」。配置里没有单独的 automation 模式。协议节点把 `events:false`、`pollSec:900` 写进 `node.json` 后，doctor 仍称它为 poll。传输工厂也如此：`src/transport/index.mjs` 28–31 行，`events===false` 且没有门铃文件就是 poll。webhook 不在本进程里（同文件 1–3 行）。

本次没有重跑 `lah doctor`，避免读取真实凭据和访问飞书。结论来自上述分支，不依赖报告里的 `doctor-final.log`。

REST 读写走 `FeishuBus` 的应用凭据，不经过 `lark-cli`。长连接在没有 Local Event Bus 时，doctor 330 行自己也写明会改走 WSClient。`lark-cli` 仍用于 setup 里的用户身份订阅注册（1021–1022 行）和可选的本机事件总线。

**影响面：** 所有跑 doctor 的配置。host / inbox 节点缺 CLI 会被同一门槛挡住。协议节点若把 doctor 退出码当成验收门，会被挡住，但总线读写本身不依赖这个二进制。

**最小修法：** 凭据已能取 token、且不是 hub、且 `events!==true` 时，缺 `lark-cli` 改为 info，退出码不因此为 1。hub 或显式 ws 仍提示订阅注册需要 CLI。唤醒文案在 `events===false` 且 `pollSec>=sweepSec` 时写成「仅对账间隔」，避免把协议节点说成 45 秒轮询。不必为此改标准。

---

## B07 — 接入文档互相冲突

**结论：部分成立。P2。** 下面每条都对过当前文件。没有把整份文档判成过时。

### 已过时，且和现行标准矛盾

- `docs/architecture.md` 86–87 行仍写：一台机器要同时当 hub 与 node，就起两个守护进程、各用一个配置目录。现行标准 §0 第 6 条与 §10.1 241–242 行是单进程、单配置目录超集。README「路径 B」101–121 行也是单进程。报告把 85–94 行整段说成双进程：过时的是 86–87 这一句；88–94 行的职责（建单顺序、auth_decision、canceled、hub 强制 ws）与现行标准一致。85 行「hub 是逻辑角色，不是独立进程」也还在，和下一句叠在一起。
- `DESIGN.md` 63 行与报告一致，仍是两个进程、两个配置目录。同页 58–62 行的三种唤醒描述与 §10.3 一致，不用整节作废。

### 同一页里的真矛盾

`docs/hub-integration.md` 96–104 行，报告的范围是对的：

- 96–101 行：呈递写入 `present_queue.jsonl`，去重键含线上 `Tasks.Metadata.presented_keys`，飞书端不发文本结果。这与标准 §8.5 190–193 行、§10.1 第 5 点一致。
- 102 行：「不回写 Tasks」。与上一行的 `presented_keys` 同步描述冲突。
- 104 行：「正文直接发到机主私聊。……没有队列文件。」与 98、101 行冲突，也与现行 §8.5 冲突。

这是同节改到一半：队列模型已写入前面，私聊旧句留在 104 行。标准修订记 v3.1（`docs/standard.md` 222 行）仍用过去时叙述「两个守护进程」和「§8.5 改为直接发机主私聊、不再描述队列」。现行正文已被 §0.6、§8.5、§10.1 和 v3.2 修订记（211–214 行，改回本地队列）覆盖。修订记应保留历史，不要改成现在时；它不是第二份现行规范。

### 手册相对标准的缺口（真缺口，手册其余条款仍可用）

`docs/protocol-node-runbook.md` 全文 51 行。

- 第三节第 1 条（43 行）：同幂等键「只回 notice」。标准 §8.4：新任务置 `rejected`，notice 指向原任务。手册第 2 条对「没有的能力」写了 rejected，所以不是通篇不提 rejected。缺的是同键这条。
- 盯表矩阵 35 行：`auth_decision→读 DataPart 的 decision 执行/关单`。第三节第 5 条（47 行）写了 DataPart 与自有红线，没有标准 §8.3 的四条（`From_Node=hub`、`Role=user`、`In_Reply_To=当前 Status_Msg`、最新一条为准），也没有写明 `canceled` 只由 hub 写。矩阵里的「关单」可以被读成协议节点自己落 `canceled`。这是真缺口。
- 全文没有可复制的 webhook JSON、水位文件字段、提交补齐步骤、15 分钟触发器配置。有「只带 ID」（29 行）和「写操作串行」（51 行）。报告这句成立。标准 §10.3 已经规定只带 ID、15 分钟对账，缺的是手册里的操作样例，不是标准没写原则。

### README / 标准把 Grok Bot 写进了两条路径

- README 53 行、标准 §10.4 289 行、`skills/lah/SKILL.md` 85 行：Grok Bot 是 `kind=agent` + inbox，本尊每轮调用 `lah inbox`。
- README 125–132 行、手册 5–9 行与 29 行、标准 §10.3 表：无守护进程、有固定地址的外部节点（举例 Grok bot）走 `Receive_Mode=automation`。

两段各自描述了一种存在的形态，都没有写「没有常驻进程就不要走 inbox」。读者无法从一处得到唯一做法。详见设计问题 A。

**最小修法：** 以现行 `docs/standard.md` 正文为准，改 architecture 86–87、DESIGN 63、hub-integration 102 与 104、手册第三节第 1 条和第 5 条、README 与 Skill 里 Grok Bot 的例子。标准正文不用为了迁就这些旧句而改回去。修订记 222 行可加半句「进程模型与呈递通道已由后续正文取代」，避免读者把变更记当现行条款。

---

## B08 — task create 会向停派 / offline 名片派单

**结论：已确认。P1。** 最近一次提交没有修掉它。

`1308f51` 对 `src/hub/create.mjs` 的改动只删了 `ops-agent` 的 100 分和 `echo-test` 的降权，其余仍是 `return 50 + online`。当前自动选择在 155–173 行：

- `nodeCards` 只按 `Node` 过滤，不看 `Dispatchable`。
- `Availability` 不是 `offline` 时加 10 分，offline 仍留在候选里。
- `Skill_ID=agent` 或 Metadata `kind=agent` / `mode=inbox` 得 200 分，再加 online 的 10 分。

显式 `--cap` 在 129–133 行命中 `Cap_ID` 后直接采用，不读 `Dispatchable` 或 `Availability`。

fake Bus：

- 只有一张 `Dispatchable=No`、`Availability=offline`、`Skill_ID=agent` 的 grokbot 名片，`createTask({ to: "grokbot" })` 成功，写出 instruction、Part、Tasks 共 3 笔，`Skill_ID=agent`，`Status=submitted`。
- 同节点再加一张 `Dispatchable=Yes`、`Availability=online`、`Skill_ID=echo`：自动选择仍是 `agent`（200 > 60）。
- 显式 `cap: "CAP-grokbot-agent"` 指向那张 No/offline 名片：同样写出 `submitted`。

标准 §6 140 行「只接自己登记且 Dispatchable=Yes 的能力」约束的是接收方。`myCapabilities`（732–739 行）确实只收集 `Dispatchable=Yes`。守护进程因此不会认领停派名片上的技能，任务停在 `submitted`，直到 hub 的陈旧告警。标准没有逐字规定建单入口必须在第一笔写之前拒绝。建单把停派标志绕开了，automation 门铃仍会发出。

**影响面：** 所有经 `lah task create` 派出的任务，不区分目标是 host、inbox 还是协议节点。守护进程接收方不执行停派技能。协议节点若按手册第三节第 2 条自觉拒绝，门铃已经发出。报告把 `Dispatchable=No` 当作切换期安全开关，这个开关在建单侧不成立。

**根因：** 自动选择只做打分，显式 Cap_ID 只做查找。`1308f51` 的优先级调整没有加入过滤。

**最小修法：** 先在标准 §10.1 的建单条款写明：自动选择只考虑 `Dispatchable=Yes` 且 `Availability` 不是 `offline` 的名片；没有候选则在第一笔写之前拒绝。显式 `--cap` 命中停派或 offline 时同样拒绝（需要强制派发再另加开关；当前不建议默许）。然后只改 `src/hub/create.mjs`。

---

## B09 — `--ref` 不继承父 Context_ID

**结论：已确认。P2。**

`createTask` 193–209 行读父任务只为计算 `Hop_Count`（父跳数 + 1，缺省按 0）。211 行：`contextId = 传入的 context，否则 CTX-<新 Task_ID 去掉 TASK- 前缀>`。不读父任务的 `Context_ID`。

fake Bus：父任务 `TASK-PARENT-001`、`Hop_Count=1`、`Context_ID=CTX-PARENT`，调用时不传 context。结果 `Hop_Count=2`，`Ref_Task_IDs=TASK-PARENT-001`，`Context_ID` 为新的 `CTX-20261107-…`，不是 `CTX-PARENT`。

标准 §8.2 160 行：派生任务共享 `Context_ID`。单父不继承是实现违反已有标准，修代码即可，不必先改标准。

多父且 `Context_ID` 彼此不同：标准没写。建议先在 §8.2 加一句「多父会话不一致时必须显式 `--context`，否则拒绝」，再在同一文件里实现。本次没有把多父跑进脚本。

**影响面：** 所有未带 `--context` 的派生单。按 Task_ID 的呈递与答复仍能工作。按会话把多张任务串起来的读者会断开。与目标节点种类无关。

**最小修法：** 恰好一个父任务时，缺省抄父 `Context_ID`。调用方传了 `--context` 就用调用方的。与 B08 同文件，交给同一个改动。

---

## B10 — setup 选择 sweep/automation 后仍写 pollSec 45

**结论：已确认。P2。** 只核对源码，没有跑交互向导，不能声称某台机器已经因此在 45 秒轮询。

`src/setup.mjs`：

- 1053–1056 行：选项 3 或文本含 `sweep` / `automation` 时 `events=false`，`pollSec = sweepSec`（900）。
- 1089–1104 行写 `node.json` 时字面量是 `pollSec: 45`、`sweepSec: 900`。不使用上面的 `pollSec` 变量。

对源码做了字面量检查：分支赋值在，`pollSec: 45` 在，`pollSec: pollSec` 不在。

`events:false` 时 `wakerMode` 返回 poll（`src/transport/index.mjs` 30 行），`src/transport/poll.mjs` 的等待上限是 `pollSec * 1000`。选「仅 15 分钟」会得到每 45 秒一次的 poll。hub 角色强制 ws，等待用 `sweepSec`（`src/hub/index.mjs` 5–6、175–176 行），这条硬编码不改变 hub 的对账间隔，但文件里仍会写下 `pollSec: 45`。

选项文案写了 automation，落盘仍是守护进程配置。协议节点不是 `kind` 的第三种，setup 不会产出「不启动 daemon」的配置。

**影响面：** 经 setup 选择第 3 项的 node 角色（host 与 `kind=agent`）。手写 `node.json` 的协议节点不受这一行影响。

**最小修法：** `nodeJson.pollSec` 改为变量 `pollSec`。hub 分支可继续不提供该选项。不必改标准（§10.3 已写 poll 默认 45 秒、对账 900 秒）。补非交互 `--wake sweep` 是另外的增强，不是修好这个覆盖所必需的。

---

## B11 — 没有清理/重配入口；安装会改全局 Skill

**结论：现象已确认。P2。倾向见设计问题 B：加跳过开关和只读盘点值得做；自动清库不值得做。**

- `install.sh` 47–50 行：无条件 `mkdir` 并 `cp` 到 `$HOME/.agents/skills/lah/SKILL.md`。报告写 45–49 行，实际复制在 49–50 行。
- `src/setup.mjs` 1195–1204 行：同样复制，失败被空 `catch` 吃掉。没有 `--skip-skill`。
- `bin/lah.mjs` 520–532 行的帮助只有 setup、daemon、doctor、service、host、task、present、inbox。没有 dry-run、cleanup、migrate。

本次没有执行 `install.sh` 或交互 setup。结论来自上述源码。

这是部署体验缺口。它不导致错误的 Runs 或重复 result。

---

## 设计问题 A — 无常驻进程的 Agent 该走哪条路

**报告的选择成立。主因是接入形态，B01–B05 是附加理由。**

`kind=agent` + inbox 的现行定义（标准 §10.4 289–296 行、README 53 与 90–97 行）是：

1. 本机有守护进程认领任务、把条目写入 `agent_inbox.jsonl`、按约 60 秒刷新心跳；
2. Agent 本尊在自己的循环里调用 `lah inbox`。

平台 webhook 唤醒的是对方平台上的一次例行，不会读取这台机器上的 `agent_inbox.jsonl`，也不会把 lah daemon 拉起来。README 那句「每轮调用 inbox」因此覆盖不了「没有常驻进程」的 Bot。这句话成立。

即便 B01–B05 修好，没有常驻进程仍然不应走 inbox。修好之前走 inbox，完单会在发布 schema 上失败，并可能留下 `working` 与重复 result。

官方已经写了另一条路，而且点名了这类节点：

- 标准 §10.3：webhook / `Receive_Mode=automation`，例子是无法建长连接但有固定地址的外部节点，如 Grok bot。必须另有 15 分钟对账。
- README 125–132 行「接入外部 bot」。
- `docs/protocol-node-runbook.md` 开篇与第 29 行。
- `docs/architecture.md` 71–78 行的「协议接入型」列。

文档没有讲成一条可执行的唯一路径。标准 §10.4、README 53 行和 Skill 85 行又把 Grok Bot 写成 inbox 例子。手册有状态机，没有 webhook 正文样例、水位文件和 15 分钟触发配置（B07）。setup 的第 3 项文案带 automation，落盘仍是会 poll 的 daemon 配置（B10）。

建议在 README 与 §10.4 各加一段界限：有守护进程、本尊能调用 `lah inbox` 的，用 `kind=agent`；只有平台 webhook、没有常驻进程的，用协议节点，不跑 daemon，不把 doctor 缺 CLI 当成失败。样例放到手册，不改状态机语义。

---

## 设计问题 B — 要不要做清理 / 重配入口

**值得做窄的两件事。不值得做会写总线或删表的迁移器。**

值得做：

- `install.sh` 与 `lah setup` 增加 `--skip-skill`（或环境变量）。协议节点重配、以及明确不改本机 Agent 技能时，可以避开 `~/.agents/skills/lah`。默认仍安装，因为 host / inbox 节点的预期用户就是终端 Agent。
- 只读盘点：列出本节点名片、指向本节点的未终态任务、本机配置文件名。不打印凭据，不写表。给人工交接一张清单。

不值得做：

- 按节点自动删除 Tasks / Messages / Runs / Rules 的 cleanup。七表是共享总线，现场同时有别的节点。误删成本高于手写一张删除清单。
- 把「旧 webhook 例行、旧 prompt、旧本地脚本」收成官方迁移器。那些位置不在本仓库的数据模型里，程序无法安全判断哪些文件是旧试点。

`install.sh` 重跑不覆盖已有 `node.json`（脚本头 9 行）这点可以保留。缺的是技能复制的开关，不是另一套安装器。

---

## 设计问题 C — 修复计划

原则：标准已经写明的行为，直接改实现。标准清单没写的新列、新的建单拒绝规则、多父会话冲突，先改 `docs/standard.md`，再改实现，CHANGELOG 记一笔。改表先改线上 Base，再跑 `schema/generate_schema.mjs`，不手改生成物。

### 必须先改标准的项

| 项 | 改标准的原因 |
|---|---|
| B05 | §6 的名片清单没有 Metadata。先把列写进 §6，再加线上列并重新生成 |
| B08 | §6 只约束接收方。建单侧拒绝停派 / offline 是新规则，先写入 §10.1 |
| B09 的多父冲突 | 单父继承 §8.2 已要求，可直接改代码。多父 `Context_ID` 不一致时拒绝，先补一句 |
| B01 的「fail 不重试」 | 只在决定把直接终态留成正式语义时，补进 §10.4。字段修复本身不必等 |

B02、B03、B04、B06、B07、B10、B11 的修复对齐现有标准或只改工具行为，不必先改标准。B07 是让其他文档跟上现行正文。

### 并行任务（按文件切开）

`CHANGELOG.md` 不要分给多个任务。下面除任务 1 外都不改它；任务 1 在合并时按各任务的说明补条目。谁也不要改 `src/kernel.mjs`。

1. **标准补丁**，独占 `docs/standard.md`，并在合并时写 `CHANGELOG.md`。  
   内容：§6 增加 `AgentCards.Metadata`；§10.1 增加建单过滤；§8.2 增加多父上下文一句；若采纳「inbox fail 不重试」则补 §10.4。  
   B05 的线上加列和重新生成依赖这段正文落地，并且要人在 Base 上操作。生成物任务不要和本任务同时改标准。

2. **inbox**，只改 `src/inbox.mjs`。  
   B01、B02、B03、B04。可以按现有 §4、§5、§8.1 开工，不必等任务 1，除非任务 1 把 fail 的重试语义改成必须回 `submitted`。outbox 写在本文件里，不抽进内核。

3. **建单**，只改 `src/hub/create.mjs`。  
   B08、B09。B09 的单父继承可以先做。B08 的拒绝行为等任务 1 的句子落地后按句子实现，避免两个任务各写一套规则。因此这个文件不要拆给两个人。

4. **schema 生成**，只碰 `schema/base-schema.json`、`docs/base-schema.md`（由脚本写出）。  
   前提：任务 1 已改 §6，且线上 Base 已加 `AgentCards.Metadata`。运行 `schema/generate_schema.mjs`。不手改。不与任务 2、3 重叠。

5. **setup / 安装**，只改 `src/setup.mjs`、`install.sh`、`bin/lah.mjs`（帮助文案）。  
   B10：`pollSec` 使用变量。B11：`--skip-skill`。不做清库命令。

6. **doctor**，只改 `src/doctor.mjs`。  
   B06：无 CLI 且非 ws/hub 时降为提示。字段完整性检查等任务 4 的生成物落地后再改同一文件，不要和本任务并行。

7. **接入文档**，只改 `README.md`、`DESIGN.md`、`docs/architecture.md`、`docs/hub-integration.md`、`docs/protocol-node-runbook.md`、`skills/lah/SKILL.md`。  
   B07，以及设计问题 A 的路径分界。不改 `docs/standard.md`。

建议顺序：任务 1 与任务 2、5、6、7 可以同时开始。任务 3 在任务 1 的建单句子合并后开工。任务 4 在加列之后开工。任务 6 的字段检查排在任务 4 之后。

### 前三项

1. **`src/inbox.mjs`：B01 + B02 + B04，顺手做 B03。** 这是会留下 `working`、写错台账、重试复制 result 的路径。标准已经够用。
2. **B05：改 §6 → 线上加 `AgentCards.Metadata` → 重新生成 schema。** 否则按发布文档新建的守护进程登记不上能力。
3. **B08（及同文件的 B09）：标准补上建单过滤后改 `src/hub/create.mjs`。** `Dispatchable=No` 目前挡不住 `lah task create`，也挡不住因此发出的 automation 门铃。
