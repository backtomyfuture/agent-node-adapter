# Changelog

本项目的主要变更记录如下。节点适配器版本号见 `package.json` /
`hub-node --version`；中台标准版本独立编号（现行 v3.0）。

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
