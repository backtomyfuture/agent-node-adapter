# Changelog

本项目的主要变更记录如下。节点适配器版本号见 `package.json` /
`hub-node --version`；中台标准版本独立编号（现行 v3.0）。

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
