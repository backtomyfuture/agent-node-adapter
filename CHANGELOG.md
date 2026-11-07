# Changelog

本项目的主要变更记录如下。节点适配器版本号见 `package.json` /
`hub-node --version`；中台标准版本独立编号（现行 v3.1）。

## [Unreleased]

- 装机、自检与事件传输优化（复用本机 `lark-cli`、Local Event Bus 与本地 Agent 自动扫描）：
  - `install.sh` 移除预先生成空壳 `app.env` 的步骤；
  - `hub-node setup` 优先检测并复用本机 `lark-cli`（支持新版 `lark-cli` AES-256-GCM 安全存储自动解密、未初始化时自动交互式调起 `lark-cli config init`、自动探测包含 6 张标准表的多维表格 Base 作为默认值、以 `--as user` 注册并校验云文档事件订阅）；
  - `hub-node setup` 新增本地终端 Agent 自动扫描发现：探测常见用户级路径下已安装的 CLI Agent（`claude`, `codex`, `agy`, `gemini`, `amp`, `droid`, `grok`, `hermes`, `cursor-agent`, `opencode`, `aider` 等），自动生成写入带绝对路径与标准安全字段的标准 `commands.json`，并将首选主力 Agent 自动注册为通用的 `ops-agent` 能力模板；
  - `hub-node setup` 完善唤醒方式三级引导与检查：自动检测飞书开放平台应用线上版本事件订阅配置与云文档订阅状态，支持秒级长连接（ws）、Local Event Bus 复用与 45s 轮询无缝切换；
  - `hub-node doctor` 新增完整的环境与权限诊断：
    - `lark-cli` 状态检查；
    - Base 协作者编辑权限诊断提示；
    - 飞书开放平台应用线上版本是否订阅 `drive.file.bitable_record_changed_v1` 事件诊断；
    - `--as user` 云文档事件订阅状态（`is_subscribe`）自检；
    - 本机 `lark-cli` Local Event Bus（`bus.sock`）在线与复用状态检查；
  - `src/transport/ws.mjs` 秒级门铃机制增强：优先复用本机 `~/.lark-cli/events/<appId>/bus.sock` 共享长连接事件流；同时实时监控同目录下 `bus.log` 增量，通过正则提取 `drive.file.bitable_record_changed_v1` 并按 `message_id` 去重触发门铃，规避 Go SDK 本地事件总线丢弃非内置 handler 事件的问题，确保秒级事件唤醒 100% 稳定送达。

- 仓库只保留 Node。删除 `hub/` 下的 Python 枢纽（含接收端、呈递扫描、审批发卡、systemd 单元与自愈脚本）和 `schema/generate_schema.py`。Base 结构生成器改为 `schema/generate_schema.mjs`（Node >= 20、全局 `fetch`，不新增依赖）；生成物页眉字符串未改，以便与现有 `schema/base-schema.json`、`docs/base-schema.md` 逐字节一致。
- `hub-node daemon` 省略 `--role` 时与 doctor、service 一样：先读配置目录 `node.json` 的 `role`，缺省 node。
- `hub-node task create` 为现行建单入口（先写 instruction 与 Parts，最后写 Tasks 行）。Rules 自动路由仍为计划。hub 角色的呈递、审批与陈旧告警由 `src/hub/` 在同一守护进程里完成，状态文件在配置目录（`approval_state.json`、`present_state.json`、`stale_state.json`）。
- 中台标准 v3.1（hub 与 node 合一、统一传输方式；表结构不变，只改文档，
  实现在后续阶段跟进）：
  - §0：新增第 6 条，hub 是逻辑角色，不是独立进程或独立实现；第 3 条
    「只出不进」写明 webhook 只指出站通知，本项目不提供入站端点，与 §6
    Receive_Mode 枚举对齐。
  - §10.1（新增）：定义 node / hub 两个角色；hub 职责为建单（instruction
    消息 → Parts → Tasks 行，入口 `hub-node task create`）、发审批卡、
    回调校验机主、写 auth_decision（From_Node=hub、Role=user、
    In_Reply_To=当前 Status_Msg）、写 canceled、结果呈递、陈旧任务告警。
    原有枢纽约束不变，改由 hub 角色承担；角色边界：node 角色从不写
    auth_decision 与 canceled，hub 角色是唯一写方。一台机器要同时承担
    两角色就起两个守护进程、各用一个配置目录。hub 角色强制长连接
    （审批卡回调只能经长连接送达），node 角色可选 ws / poll。
  - §10.2（新增）：应用身份默认 hub 与 node 两个应用（身份隔离），也可
    共用一个应用，并写明代价（审计不可区分、权限并集、凭据泄露可冒写
    hub 决定、吊销联动）。
  - §10.3（新增）：唤醒方式定为 ws（SDK 长连接，出站）、poll（默认 45
    秒）、webhook 三种——webhook 专指飞书多维表格自动化 POST 通知（只带
    ID，Receive_Mode 统一记 `automation`，遗留选项 `webhook` 不再使用；
    本项目任何进程不主动推送），均保留 15 分钟对账兜底；Receive_Mode
    沿用现有选项，ws 记为 `event`，守护进程型节点只取 `event` / `poll`。
  - §2 canceled、§3 唤醒语义、§6 Receive_Mode、§8.3 写入方、§9 节点传输
    随之改写。
- hub 角色由 `hub-node daemon --role hub` 承载，代码在 `src/hub/` 与
  `src/transport/`。省略 `--role` 时读 `node.json` 的 `role`，缺省 node。
- 装机与运维角色适配（任务 E）：
  - `hub-node setup` 支持 `--role node|hub`（默认 node）：hub 角色收集机主 `ownerOpenId`（用于审批发卡与回调鉴权），无需 `commands.json`；尝试调用 `lark-cli` 自动完成云文档事件订阅注册，未就绪时给出清晰的一次性手动注册步骤。凭据写 600 权限的 `app.env`，不打印明文。
  - `hub-node doctor` 支持 `--role node|hub` 按角色检查：打印当前角色与唤醒方式；hub 角色不要求 `commands.json`，校验长连接模块与机主配置。
  - `hub-node service` 支持 `--role node|hub`：自启命令显式透传 `--role`，macOS（`hub-node-${role}.${node}`）与 Linux（`hub-node-${role}-${node}.service`）按角色命名服务，支持单机同时部署 hub 与 node 互不覆盖。
  - 上手指南与文档精简（README.md / CONTRIBUTING.md / install.sh）：README 上手部分重构为「加入现成中台（装 node）」与「自建中台（单机起 hub + node 双角色）」两条精简路径（各约 3 步），新增外部 bot 经飞书自动化 webhook 接入说明。
- 同步更新 `docs/architecture.md`、`docs/hub-integration.md`、`DESIGN.md`
  （§6 唤醒、§11 仓库结构）、`AGENTS.md`、`README.md`。
## [0.5.0] - 2026-11-05

- 中台标准 v3.0 补订（第二评审收敛，表结构不变；见
  `docs/reviews/2026-11-05-optimization.md`）：
  - §4/§8.1：执行失败才计入重试；执行成功但回执无效直接 failed＋notice，
    提交总线中途失败只补齐提交，均不重跑、不重做副作用。
  - §8.3：approve 类任务在认领前 submitted→auth-required；生效审批级别取
    任务行与节点 `approval_class` 中更严者；枢纽回调须校验操作者是机主；
    有效 auth_decision 须 From_Node=hub、Role=user、In_Reply_To 等于当前
    Status_Msg、以最新一条为准、只认 DataPart。
  - §8.4：Idempotency_Key 在非 failed/canceled 任务中只执行一次，重复者
    rejected＋notice 指向原任务；心跳回收计入 Retry_Count，超限 failed＋notice。
  - §8.5：呈递去重按 (Task_ID, Status_Msg)，已呈递 Msg_ID 记入 Tasks.Metadata。
  - §9：agent 输入约定，指令与数据经 `input.json` 隔离，参数带执行控制键直接拒收。
- 节点 P0/P1/P2：写状态前重读，终态或认领人已变则放手；配置目录单实例锁；
  心跳回收并入每轮对账并与收尾写串行。执行与提交分离，创建记录带
  client_token，提交中断只补齐 outbox。carrier 命令不再静默直跑，stdin
  EPIPE 不击穿进程；超时杀掉进程组，`timeout_sec` 夹在本机上限内。指令、
  问答与 FilePart 只经 `input.json`；续跑走同一套 preflight。能力表热更新，
  解析失败保留上一版。消息按轮建索引。幂等键查重；认领后开 Run、结束时关行。
- 枢纽 P0-3/P1-3/P1-8/P2-6：审批回调核对机主 open_id，未配置则拒绝；批准回
  submitted 时保留 Status_Msg。呈递全表翻页，按 (Task_ID, Status_Msg) 去重，
  键写入 Metadata；`--sweep` 作 20 分钟兜底并告警陈旧 working。审批卡展示
  待执行正文（凭据样键名脱敏），每成功一张立即落状态。自愈脚本失败打印
  BROKEN 并以非 0 退出。
- 装机与运维 P1-4/P2-5/P2-7：首装不再种下会挡住 setup 的示例配置；移除
  `--app-secret`，Secret 输入不回显，app.env 非 600 不读。doctor 把 socket
  在线与局域网可达分开，新增 `--probe`。配置加载失败打出原因、退避后以非 0
  退出。`DAEMON_VERSION` 为 `node-0.5.0`。

## 2026-11-05 — 项目更名为 lark-a2a-hub

- 项目名由 `agent-node-adapter` 更名为 `lark-a2a-hub`（同步更新 `package.json`、`package-lock.json`、`install.sh` 及文档中的仓库地址 `backtomyfuture/lark-a2a-hub`）。

## 2026-11-05 — 全量设计与枢纽参考实现公开

- 新增 `docs/`：中台标准 v3.0（standard.md）、系统架构（architecture.md）、
  Base 字段级结构（base-schema.md）、枢纽对接规范（hub-integration.md）、
  协议接入型节点运行手册（protocol-node-runbook.md）。
- 新增 `schema/`：`base-schema.json`（由运行中的 Base 经字段 API 生成）
  与生成器 `generate_schema.py`——改表后重跑即可同步文档。
- 新增 `hub/`：枢纽参考实现（总线客户端、长连接事件接收端、呈递扫描器、
  审批卡发送器、systemd 单元与自愈脚本），全部参数化、无真实凭据。
- 顶层 README 改为系统总览；新增 CONTRIBUTING 与本文件。

## [0.4.1] - 2026-11-05

- `hub-node setup` 改纯提示式：交互只问 Base 链接、节点名、在哪用
  （1 家里 / 2 公司）；能力前缀自动取节点名末段；写文件前一行汇总确认。
  参数模式不变。

## [0.4.0] - 2026-11-05

- 新增 `hub-node setup` 一键配置向导：自动安装 lark-cli（缺失时）、复用
  其已配置的飞书应用（凭据只在本机解析、绝不打印）、按表名自动发现
  Base 六表、生成 app.env / node.json / commands.json、运行 doctor、
  可选注册自启。

## [0.3.0] - 2026-11-04

- M4 carrier context：`commands.json` 条目可声明 `"context": "carrier"`，
  守护进程经本地 unix socket 交 `hub-node host` 在用户终端语境代跑
  （macOS 局域网权限场景）；carrier 离线时能力自动标离线、任务明确
  拒收，绝不静默改走直跑。doctor 增加 carrier 检查段。

## [0.2.0] - 2026-11-04

- M3 安装与自启：`install.sh` 一行安装（配置与程序分离、重跑只更新
  程序）、`hub-node doctor` 全项自检、`hub-node service` 注册/卸载
  开机自启（macOS launchd / Linux systemd 用户单元）。

## [0.1.0] - 2026-11-04

- M1/M2：内核自生产 Python 参考实现移植到 Node——认领租约与心跳、
  命令模板执行（json / agent 两模式）、能力自注册（AgentCards）、
  提问（input-required）与审批（auth-required）续跑、跳数熔断、
  幂等对账、失败重试；飞书后端含同表写冲突（1254291）与限流退避、
  长连接事件订阅唤醒＋低频对账兜底。
