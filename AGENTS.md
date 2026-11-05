# AGENTS.md — lark-a2a-hub

lark-a2a-hub：以飞书多维表格为共享总线、按 A2A 数据模型调度多 Agent 的中台。
本仓库含节点守护进程 `hub-node`（Node）、枢纽参考实现（Python）与中台标准文档。

## 目录与职责

- `bin/hub-node.mjs`：CLI 分发 `setup | daemon | doctor | service | host`；配置目录取 `--config <dir>` > `HUB_NODE_HOME` > `~/.hub-node`（内含 `node.json`、`commands.json`）。
- `src/kernel.mjs`：协议状态机，唯一写任务状态的节点代码。常量 `DAEMON_VERSION`、`HOP_LIMIT=8`、`MAX_RETRIES=2`、`STALE_MIN=20`（无心跳 20 分钟回收）。
- `src/bus/feishu.mjs`：Bitable REST 客户端（全局 `fetch`）；对 1254291 写冲突与 429/5xx 退避重试；`f1()` 把单元素数组字段取成标量。
- `src/bus/feishu-events.mjs`：长连接订阅 `drive.file.bitable_record_changed_v1`，只当门铃叫醒内核，不解析事件内容。
- `src/carrier.mjs`：carrier 语境（unix socket 上的 NDJSON，`ping` / `exec` 两种帧）。
- `src/setup.mjs` / `src/doctor.mjs` / `src/service.mjs`：装机向导、只读自检、LaunchAgent/systemd 用户级自启。
- `src/executors/echo.mjs`：json 模式示例执行器（stdin 读信封，stdout 回显）。
- `hub/`：枢纽参考实现（Python 3；仅 `event_receiver.py` 依赖 `lark-oapi`，`present_results.py` 走 `lark-cli`）。审批卡回调在 `event_receiver.py` 写 `auth_decision` 并把任务置 `submitted` / `canceled`。
- `docs/standard.md`：**中台标准，权威**。`docs/base-schema.md` 与 `schema/base-schema.json` 是生成物。
- `config/*.example.json`：配置样例，只放占位符。

## 命令（仓库里只有这些，没有 npm scripts、测试套件和 lint）

```sh
npm install --omit=dev                     # 唯一运行时依赖 @larksuiteoapi/node-sdk；未安装时连 -v 都会报模块缺失
# 语法检查：node --check 只检查第一个文件参数，必须逐个跑；src/**/*.mjs 在默认 shell 里会漏掉 src/*.mjs
for f in bin/hub-node.mjs src/*.mjs src/*/*.mjs; do node --check "$f" || exit 1; done
python3 -m py_compile hub/*.py schema/generate_schema.py
echo '{"k":1,"_hub":{"task_id":"TASK-X"}}' | node src/executors/echo.mjs   # json 回执冒烟
node bin/hub-node.mjs doctor  --config <dir>   # 示例配置与真实配置各跑一遍
node bin/hub-node.mjs daemon  --config <dir>
node bin/hub-node.mjs host    --config <dir>   # carrier，只能由用户在终端里启动
node bin/hub-node.mjs setup   --config <dir> [--yes --base … --node … --zone … --prefix …]
APP_ID=… APP_SECRET=… HUB_BASE_TOKEN=… python3 schema/generate_schema.py   # 改表后同步 schema 文档
```

不要编造 `npm test` 或新增测试框架；需要验证时写临时脚本，用完删掉。

## 代码约定

- Node >= 20，ESM `.mjs`，HTTP 只用全局 `fetch`。新增运行时依赖须有充分理由。
- 内核是薄壳：新能力 = `commands.json` 一条模板（`command`、`mode: agent|json`（默认 agent）、`context: direct|carrier`、`timeout_sec`（默认 600）、`cwd`（默认配置目录）、`side_effect`、`cap_id`、`name`、`desc`），启动时自动登记 AgentCards。不往内核里塞执行器或某个 Agent 的专用代码。
- 读写总线一律经 `FeishuBus`，读字段用 `f1()`；写操作逐条 `await`，不对同表并发写（不用 `Promise.all` 批量写）。
- 常驻韧性：启动期任何失败都只记日志、进主循环重试，进程不退出；能力登记成功前不处理任务。
- 唤醒标志在 `run()` 扫表前清零，不在 `waitWake()` 里清（ECHO-004 竞态）；事件只是门铃，15 分钟对账扫表是兜底。
- 注释用中文，写「为什么」，沿用现有风格。
- 标准优先：实现与 `docs/standard.md` 冲突时先改标准、再改实现，并在 `CHANGELOG.md` 记一笔。
- 改表结构：先改线上 Base，再跑 `generate_schema.py`，把生成物与代码一起提交；不手改生成物。
- 发版：同步 bump `package.json`、`package-lock.json`、`src/kernel.mjs` 的 `DAEMON_VERSION`，并在 CHANGELOG 顶部加条目。

## A2A 约束（本项目用到的部分）

- 只借数据模型，不借通信：不实现 JSON-RPC / gRPC / HTTP+JSON / SSE / Webhook，节点只读写表。
- 状态八态，拼写固定：`submitted`、`working`、`input-required`、`auth-required`、`completed`、`failed`、`canceled`（单 l）、`rejected`。
- 节点允许的迁移：`submitted→working`（写 `Claimed_By`、`Heartbeat_At`，认领后回读校验，丢了就放手）；`working→completed | input-required | failed`；执行失败未达 `MAX_RETRIES` 或心跳超时回收时回 `submitted`（回收计入 `Retry_Count`、与执行失败共用上限，超限置 `failed` + notice）；执行成功但回执无效直接 `failed` + notice，提交总线中途失败只补齐提交，二者都不计重试、不重跑（标准 §4）；`submitted→auth-required | rejected | failed`（熔断）；已有 `result` 消息的 `submitted` 任务对账为 `completed`。`canceled` 只由发起方/枢纽写。
- 终态不可变、不可重启：终态任务不得改回非终态。后续工作在同一 `Context_ID` 下新建任务，新任务首条 instruction 消息的 `Ref_Task_IDs` 指回前任。
- 中断态在原任务续跑：`question` 之后出现 `answer` 就在同一任务继续（`resumeCheck`），禁止为答问题新开任务。
- 状态与消息配套：`input-required` ↔ `question`，`auth-required` ↔ `auth_request`（`Status_Msg` 指向该 Msg_ID），`completed` ↔ `result`（有产物先登记 Artifacts），`failed` / `rejected` ↔ `notice` 说明原因。
- 审批只认 `auth_decision` 消息的 DataPart（`{"decision":"approve"}`），且须 `From_Node=hub`、`Role=user`、`In_Reply_To` 等于任务当前 `Status_Msg`，同一请求多条决定以最新一条为准；不认 TextPart 文字和任务行上的标记（标准 §8.3）。
- Messages、Parts 只追加，永不修改或删除。消息正文全在 Parts（`text` / `file` / `data` 三型，按 `Seq` 拼接）；任务参数在首条 instruction 消息的 DataPart，Tasks 表不存参数。
- ID 形态：`MSG-<任务号>-NN`、`<父ID>-P<序号>`、`<任务ID>-A<序号>`、`<任务ID>-R<序号>`。`Role` 只有 `user` / `agent`。
- 产物修订 = 同 `Name` 的新 `Artifact_ID`；内容是 FilePart 指针，大文件本体不入表。
- 本地新需求放原生 `Metadata` 字段，不新增列。

## 安全红线（借鉴 agent-autoloop，已实现或标准明确要求）

- 跳数熔断：`Hop_Count > 8` 时只写 Runs(failed) + notice 并置 `failed`，不执行。派生子任务 `Hop_Count = 父 + 1`，累加不清零（问人也不清）。
- 结构化回执，不猜自然语言：agent 模式只认 ```` ```agent-ask ```` 代码块（→ input-required）与 `ARTIFACT:` / `ARTIFACT_NAME:` 行；json 模式只认 stdout 最后一行 JSON（`summary`、`artifact`、`artifact_name`、`need_input`）。扩展回执语法须同时改 `buildPrompt`、`parseAgentOutput` 与标准 §9。
- 指令与数据分离：要执行什么命令、在哪个目录、用哪个语境，只来自本机 `commands.json`。不得新增从任务参数或消息正文读取 command / cwd / context / Agent / 权限的路径；现存唯一例外是 `params.timeout_sec`，不要扩大。标准 §9 已规定 agent 输入约定：指令文本、参数与答复只经本次执行的 `input.json` 作为数据传入，prompt 只含受信模板与文件路径，参数带执行控制键（command / cwd / context / agent 等）直接拒收。若 `buildPrompt` 仍把指令文本与参数 JSON 直接拼进 prompt，即属未达标准的存量缺口，不要在此基础上再放宽。
- 失败要响：carrier 离线时对应能力标 `Availability=offline`、任务置 `rejected` + notice，绝不静默改走直跑；守护进程只连接 carrier，从不拉起它。
- 只出不进：不开监听端口（carrier 的 unix socket 除外）、不做端口映射或隧道。
- 凭据不入仓库、不入总线、不进日志：示例只用占位符；真实值在 600 权限的 env 文件里；setup 与 doctor 不打印凭据明文。
- 建单顺序（枢纽侧）：先写 instruction 消息与 Parts，最后写 Tasks 行；Tasks 行是触发信号。
- 机主审批红线：对外发消息、删改数据、花钱、提交表单、改权限的动作走 `Approval_Class=approve` 与 auth-required 流程；生效级别取任务行 `Approval_Class` 与本机 `commands.json` 的 `approval_class` 下限中更严者，本地下限只收紧不放宽。枢纽审批回调必须校验操作者是机主。

## 禁止事项

- 不要提交 `hub/hub.env`、`app.env`、`.hub-node/`、`hub/approval_state.json`、`hub/present_queue.jsonl`，也不要提交真实 Base token、table_id、open_id。
- 不要修改或删除 Messages / Parts 行，不要重开终态任务，不要给 Tasks 加参数列。
- 不要让守护进程因启动期或单轮错误退出，不要吞掉错误后假装成功。
- 不要手改 `schema/base-schema.json`、`docs/base-schema.md`。
- 不要在节点里实现 A2A HTTP 端点或任何入站服务。
- 未经要求不要提交、推送或发版。
