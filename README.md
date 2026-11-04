# agent-node-adapter（通用节点适配器）

把任何一台终端变成多 Agent 中台的一个执行节点：装上、配好，它就常驻后台，
按「认领任务 → 拉起本机 Agent/脚本 → 收回执 → 落日志」的循环替中台干活。

设计全文见 [DESIGN.md](DESIGN.md)。当前进度：M1（内核移植）——核心循环已从
生产运行的 Python 参考实现移植到 Node，含飞书多维表格总线后端、命令模板执行
（json / agent 两种模式）、能力自注册、提问/审批续跑、熔断与幂等对账。

## 快速开始

前置：Node >= 20；一个飞书应用（凭据以 `APP_ID`/`APP_SECRET` 放在本地 env 文件，
或直接写进 node.json）与一张按中台标准建好的多维表格 Base。

```bash
mkdir -p ~/.hub-node
cp config/node.example.json ~/.hub-node/node.json      # 填节点名、Base token、七表 ID
cp config/commands.example.json ~/.hub-node/commands.json  # 按本机有的工具改命令模板
node bin/hub-node.mjs daemon --config ~/.hub-node
```

## 配置要点

- `node.json`：节点身份（node/zone）、总线参数（baseToken/tables）、凭据来源
  （appEnv 指向本地 env 文件，或 appId/appSecret 直填）、轮询与对账周期。
- `commands.json`：能力表。键是 Skill_ID，值是命令模板：
  - `mode: "json"` —— 脚本类：stdin 收任务信封，stdout 最后一行输出结果 JSON；
  - `mode: "agent"` —— Agent 类：模板含 `{prompt}`，输出纯文本＋结构化回执块。
  - 加能力只改这个文件，守护进程每轮自动重读、启动时自动登记能力名片。
- 凭据只存节点本地，绝不进总线；节点只发起出站连接，不开监听端口。

## 里程碑

- M1 内核移植（本版）
- M2 飞书后端增强：事件订阅已落地（长连接接收器集成在守护进程内，事件即时唤醒＋低频对账兜底）；剩余能力名片细化
- M3 安装与自启：curl 安装脚本、launchd/systemd 注册、`doctor` 自检命令
- M4 carrier context：macOS 局域网语境子进程（见 DESIGN.md §9）
- M5 文档与首个公开版本

License: MIT
