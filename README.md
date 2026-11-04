# agent-node-adapter（通用节点适配器）

把任何一台终端变成多 Agent 中台的一个执行节点：装上、配好，它就常驻后台，
按「认领任务 → 拉起本机 Agent/脚本 → 收回执 → 落日志」的循环替中台干活。

设计全文见 [DESIGN.md](DESIGN.md)。当前进度：M3——核心循环已从生产运行的
Python 参考实现移植到 Node 并在生产节点全量切换，含飞书多维表格总线后端、
命令模板执行（json / agent 两种模式）、能力自注册、提问/审批续跑、熔断与
幂等对账、事件订阅唤醒（长连接＋低频对账兜底）。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/backtomyfuture/agent-node-adapter/main/install.sh | sh
```

脚本把程序装到 `~/.hub-node/app`、配置放在 `~/.hub-node/`、命令入口链接到
`~/.local/bin/hub-node`；重跑即更新，已有配置不覆盖。

前置：Node >= 20；一个飞书应用（凭据以 `APP_ID`/`APP_SECRET` 放在本地 env 文件，
或直接写进 node.json）与一张按中台标准建好的多维表格 Base。

```bash
# 1) 编辑 ~/.hub-node/node.json（节点名、Base token、七表 ID）与 ~/.hub-node/app.env
# 2) 按本机有的工具改 ~/.hub-node/commands.json 的命令模板
hub-node doctor     # 自检：配置、凭据、总线连通、能力登记
hub-node daemon     # 前台试跑
hub-node service    # 注册开机自启（macOS launchd / Linux systemd 用户级；--remove 卸载）
```

手动安装等价于 clone 本仓库后 `npm install`，再把示例配置拷到配置目录。

## 配置要点

- `node.json`：节点身份（node/zone）、总线参数（baseToken/tables）、凭据来源
  （appEnv 指向本地 env 文件，或 appId/appSecret 直填）、轮询与对账周期。
- `commands.json`：能力表。键是 Skill_ID，值是命令模板：
  - `mode: "json"` —— 脚本类：stdin 收任务信封，stdout 最后一行输出结果 JSON；
  - `mode: "agent"` —— Agent 类：模板含 `{prompt}`，输出纯文本＋结构化回执块。
  - 加能力只改这个文件，守护进程每轮自动重读、启动时自动登记能力名片。
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

## 里程碑

- M1 内核移植 ✓
- M2 飞书后端增强：事件订阅已落地（长连接接收器集成在守护进程内，事件即时唤醒＋低频对账兜底）；剩余能力名片细化
- M3 安装与自启 ✓：curl 安装脚本、launchd/systemd 注册（`hub-node service`）、`doctor` 自检命令
- M4 carrier context ✓：本地 socket 代跑、能力分流与离线标注（见上）
- M5 文档与首个公开版本

License: MIT
