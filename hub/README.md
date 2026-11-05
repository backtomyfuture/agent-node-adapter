# hub/ —— 枢纽参考实现

枢纽侧的四个部件，均为单文件 Python（仅接收端依赖 `lark-oapi`）。
对接规范见 [docs/hub-integration.md](../docs/hub-integration.md)；
本目录是该规范的一份可运行实现，部署细节按你的环境调整。

| 文件 | 职责 |
|---|---|
| `hub_api.py` | 枢纽应用 bot 身份的总线客户端：tenant token、记录读写、发交互卡片。配置走环境变量（见文件头），凭据读同目录 `hub.env` |
| `event_receiver.py` | 长连接事件接收端（常驻）：记录变更事件落盘 `events.log`、防抖触发呈递扫描、承接审批卡回调。回调先核对操作者 `open_id == HUB_OWNER_OPEN_ID`（未配置则拒绝）；通过后写 auth_decision，`In_Reply_To` 填当前 `Status_Msg`。批准把任务置回 `submitted` 时保留 `Status_Msg`。呈递队列按 `(record_id, status, status_msg)` 去重 |
| `present_results.py` | 呈递扫描器：`--list` / `--sweep` 分页读全表，JSONL 含本次算好的 `present_key`、`status`、`status_msg`；`--mark` 优先写入调用方传入的本次呈递键（`--key` / `--status-msg` 或位置参数），避免呈递期间状态前进把终态键提前标掉，未传键时才按当前行计算；`--sweep` 另在 stderr 告警心跳超过 20 分钟的 working。经 lark-cli 以操作者用户身份读表 |
| `approval_watcher.py` | 审批卡发送器（单次扫描，可 cron/循环调用）：`HUB_OWNER_OPEN_ID` 为空则启动即退出；给 auth-required 的任务发卡，每成功一张立刻写入 `approval_state.json` |
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
   `approval_watcher.py` 每分钟跑一次即可（没配 `HUB_OWNER_OPEN_ID` 会直接退出）；
   呈递的消费者从 `present_queue.jsonl` 取活——可以是操作者的聊天 Agent，
   也可以是你自己的转发脚本（这条队列就是呈递接缝，见 hub-integration.md）。
   队列一行是 `{record_id, task_id, status, status_msg}`，去重键是这三项，
   不是单独的 record_id。
5. 每 20 分钟跑一次 `present_results.py --sweep` 做事件丢失后的补呈：
   stdout 与 `--list` 相同，stderr 打印陈旧 working 告警。不要把 stderr
   重定向进队列文件。升级后 Metadata 里还没有 `presented_keys` 的历史任务
   会再出现一次，`--mark` 之后按键去重。呈递成功后把清单里的
   `present_key` 交回 `--mark <record_id> --key <present_key>`（中断态也
   可用 `--status-msg`）。不要在状态可能已变化后再让 `--mark` 自己重读当前行。
6. 可选：把 `ensure_receiver.sh` 挂到定时巡检或开机检测上做自愈。

周期兜底示例（用户级 systemd，路径按部署改）：

```
# hub-present-sweep.service 的 ExecStart
python3 /path/to/hub/present_results.py --sweep
# hub-present-sweep.timer
# OnBootSec=2min
# OnUnitActiveSec=20min
```

或 crontab：`*/20 * * * * cd /path/to/hub && python3 present_results.py --sweep >>sweep.log 2>>sweep-alerts.log`

## 与生产实现的差异

本参考实现与作者自用的生产枢纽同源，仅做了参数化（路径、表 ID、操作者
ID 全部走环境变量）与命名清理。生产中的一次性迁移/对账脚本未收录。
