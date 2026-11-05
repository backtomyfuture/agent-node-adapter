# hub/ —— 枢纽参考实现

枢纽侧的四个部件，均为单文件 Python（仅接收端依赖 `lark-oapi`）。
对接规范见 [docs/hub-integration.md](../docs/hub-integration.md)；
本目录是该规范的一份可运行实现，部署细节按你的环境调整。

| 文件 | 职责 |
|---|---|
| `hub_api.py` | 枢纽应用 bot 身份的总线客户端：tenant token、记录读写、发交互卡片。配置走环境变量（见文件头），凭据读同目录 `hub.env` |
| `event_receiver.py` | 长连接事件接收端（常驻）：记录变更事件落盘 `events.log`、防抖触发呈递扫描、承接审批卡回调（写 auth_decision 并流转状态） |
| `present_results.py` | 呈递扫描器：`--list` 输出未呈递的可呈递任务（JSONL）、`--mark` 回写 Presented。经 lark-cli 以操作者用户身份读表 |
| `approval_watcher.py` | 审批卡发送器（单次扫描，可 cron/循环调用）：给 auth-required 的任务发卡，本地 `approval_state.json` 防重复 |
| `agent-hub-receiver.service` | 接收端的 systemd 单元模板 |
| `ensure_receiver.sh` | 接收端自愈：unit 缺失/服务停摆时从持久目录副本重装（适合宿主机会被整体替换的环境） |

## 身份模型（为什么有 bot 与 user 两种读法）

- 写与事件：枢纽应用（bot 身份）——`hub_api.py`、`event_receiver.py`。
- 呈递扫描：操作者的 lark-cli 用户身份——`present_results.py`。与 bot
  读法等价，选此路是让呈递天然带操作者视角，也复用了现成的 CLI 表格命令。
- 事件订阅注册：只能用户身份、且须在本机交互终端办（见
  [hub-integration.md](../docs/hub-integration.md) 的「事件订阅注册」）。

## 部署速记

1. 照 [docs/base-schema.md](../docs/base-schema.md) 建好 Base，把枢纽应用
   加为编辑者；发审批卡还需给应用开 im 发消息权限。
2. 本目录放好 `hub.env`（模板 `hub.env.example`，600），并在运行环境里
   导出 `HUB_BASE_TOKEN` 等表 ID 变量与 `HUB_OWNER_OPEN_ID`。
3. 以用户身份在本机终端完成一次事件订阅注册（同上）。
4. `pip install lark-oapi` 后用 systemd 单元托管 `event_receiver.py`；
   `approval_watcher.py` 每分钟跑一次即可；呈递的消费者从
   `present_queue.jsonl` 取活——可以是操作者的聊天 Agent，也可以是你
   自己的转发脚本（这条队列就是呈递接缝，见 hub-integration.md）。
5. 可选：把 `ensure_receiver.sh` 挂到定时巡检或开机检测上做自愈。

## 与生产实现的差异

本参考实现与作者自用的生产枢纽同源，仅做了参数化（路径、表 ID、操作者
ID 全部走环境变量）与命名清理。生产中的一次性迁移/对账脚本未收录。
