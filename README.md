# agent-node-adapter —— 多 Agent 中台（飞书多维表格总线）

一套已经在生产运行的多 Agent 协作系统：**用飞书多维表格当消息总线与
状态层**，数据模型借 A2A 协议；一个枢纽（hub）负责拆解、派发、审批与
结果呈递；任意终端装上节点适配器即可入列干活，云端 Agent 也能按协议
直接接入。任务只有一个发起面和一个状态面，全程留痕可查。

本仓库包含系统的全部公开部分：

| 组成 | 位置 | 说明 |
|---|---|---|
| 中台标准 v3.0 | [docs/standard.md](docs/standard.md) | 七表对象模型、A2A 八态状态机、通信/审批/幂等协议（规范性文件） |
| 系统架构 | [docs/architecture.md](docs/architecture.md) | 分层、核心决策与理由、生命周期、故障模型 |
| Base 结构 | [docs/base-schema.md](docs/base-schema.md) · [schema/](schema/) | 七表字段级定义，由运行中的 Base 生成（附生成器） |
| 枢纽对接 | [docs/hub-integration.md](docs/hub-integration.md) · [hub/](hub/) | 枢纽职责、建单纪律、呈递与审批回路＋一份可运行的参考实现 |
| 节点适配器 | 本仓库 `bin/` `src/` · [DESIGN.md](DESIGN.md) | 把任何终端变成执行节点：认领 → 拉起本机脚本/Agent → 收回执 → 落日志 |
| 协议接入 | [docs/protocol-node-runbook.md](docs/protocol-node-runbook.md) | 无守护进程的 Agent 按手册盯表接入（同一套协议） |

```mermaid
flowchart LR
    OP["操作者"] --> HUB["枢纽 hub"]
    HUB -->|"建单（先消息、后任务行）"| BUS["飞书多维表格总线<br/>Tasks · Messages · Parts · Runs<br/>Artifacts · AgentCards · Rules"]
    BUS -->|"事件推送＋对账兜底"| NODES["节点们：家用机 / 工作机 / 云端 Agent"]
    NODES -->|"状态 · 消息 · 产物回写"| BUS
    BUS -->|"终态 / 待答 / 待批"| HUB
```

## 作为节点加入一个现成的中台

```bash
curl -fsSL https://raw.githubusercontent.com/backtomyfuture/agent-node-adapter/main/install.sh | sh
hub-node setup      # 纯提示式向导，见下
```

脚本把程序装到 `~/.hub-node/app`、配置放在 `~/.hub-node/`、命令入口链接到
`~/.local/bin/hub-node`；重跑即更新，已有配置不覆盖。前置只有 Node >= 20
与一张按标准建好的 Base（向中台的操作者要链接即可）。

setup 是纯提示式：粘贴 Base 链接、给节点起个名、选一下机器在哪
（家里/公司），最后确认一眼即可；用哪个应用在只有一个时自动选定。
lark-cli 没装它会装、已配的应用它会复用（Secret 只在本机从配置/钥匙串
解析进 app.env，权限 600，绝不进总线）；表 ID 自动发现，app.env /
node.json / commands.json 全部自动生成，最后跑一遍 doctor 自检并可顺带
注册自启。全参数化也可以：
`hub-node setup --base <Base链接> --node <节点名> --yes --service`。

```bash
hub-node doctor     # 之后随时复检
hub-node daemon     # 前台试跑（setup 里选了自启则已在跑）
hub-node service    # 注册/卸载开机自启（macOS launchd / Linux systemd 用户级）
```

手动安装等价于 clone 本仓库后 `npm install`，再把示例配置拷到配置目录。

## 搭一个自己的中台

1. 照 [docs/base-schema.md](docs/base-schema.md) 在飞书多维表格里建七张表
   （或用字段 API 批量建），得到 Base token；
2. 按 [hub/README.md](hub/README.md) 部署枢纽参考实现（接收端常驻＋
   watcher 周期跑），并在本机交互终端完成一次事件订阅注册；
3. 每台机器按上一节入列；没有守护进程的 Agent 按
   [协议节点运行手册](docs/protocol-node-runbook.md) 接入。

## 节点配置要点

- `node.json`：节点身份（node/zone）、总线参数（baseToken/tables）、凭据来源
  （appEnv 指向本地 env 文件，或 appId/appSecret 直填）、轮询与对账周期。
- `commands.json`：能力表。键是 Skill_ID，值是命令模板：
  - `mode: "json"` —— 脚本类：stdin 收任务信封，stdout 最后一行输出结果 JSON；
  - `mode: "agent"` —— Agent 类：模板含 `{prompt}`，输出纯文本＋结构化回执块。
  - 加能力只改这个文件，守护进程每轮自动重读、启动时自动登记能力名片。
- 能力分三层：确定性脚本、指定本地 Agent 执行指定 Skill、通用能力
  （Agent＋工具面）——都是命令模板，守护进程是薄壳，不内嵌执行器。
- 凭据只存节点本地，绝不进总线；节点只发起出站连接，不开监听端口。

### carrier：需要局域网的能力（macOS）

macOS 上由 launchd 拉起的守护进程访问局域网会被系统本地网络隐私机制拦截
（见 DESIGN.md §9）。需要局域网的能力，在 `commands.json` 的条目里加
`"context": "carrier"`，再在你日常的终端（比如常开的 Ghostty/tmux 里）跑：

```bash
hub-node host     # 前台常驻，保持终端开启；Ctrl-C 退出
```

守护进程会经本地 unix socket 把这类命令交给 carrier 在终端语境里代跑；
carrier 不在线时，这些能力在名片上自动标离线、任务明确拒收，绝不静默
改走直跑。`hub-node doctor` 会报告 carrier 的在线状态。

## 版本与变更

见 [CHANGELOG.md](CHANGELOG.md)。参与改进见
[CONTRIBUTING.md](CONTRIBUTING.md)。

License: MIT
