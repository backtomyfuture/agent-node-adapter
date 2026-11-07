---
name: lah
description: 操作与调度 lark-a2a-hub (lah) 多 Agent 协作中台：查询在册节点与能力名片、派发跨节点异步任务、接收原路返回的结果队列、答复追问、查看任务状态与产物。当用户想要让其他机器/Agent干活、跨终端分发任务、调度中台能力或查询中台任务时使用。
---

# `lah` 多 Agent 协作中台调度指南

`lah`（`lark-a2a-hub`）是以飞书多维表格为共享总线的多 Agent 调度中台。任何入网终端或 Agent 都可以通过 `lah` 派发任务给其他节点，并按「谁发起、回给谁」的原路机制接收执行结果。

---

## 核心原则

1. **原路返回，飞书静默**：
   - 任务发起方（`From_Node`）派出的任务，在执行节点产出结果后，回执消息 `To_Node` 原路指向发起方，由本机的 `lah daemon` 自动写入本地 `~/.hub-node/present_queue.jsonl`；
   - 飞书端不再发送文本消息刷屏，仅在涉及敏感操作时由主枢纽发送交互式审批卡片。
2. **状态八态与生命周期**：
   - `submitted`（已入队）→ `working`（执行中）→ `completed` / `failed` / `canceled` / `rejected`；
   - 中断态 `input-required`（提问待答）：必须在原任务通过 `lah task reply` 答复，目标节点自动续跑，禁止为答复新开任务。
3. **审批拦截**：
   - 若任务涉及关键操作（对外发消息、删改数据、花钱等），会自动转入 `auth-required`。主枢纽会在飞书向机主推送卡片，机主点击批准后自动恢复执行，无需终端干预。

---

## 常用 CLI 命令

### 1. 派发跨节点任务 (`lah task create`)
向指定节点的指定能力派发异步任务：
```bash
lah task create --to <Target_Node> --cap <Skill_ID> --text "<指令说明>" [--params '<JSON字符串或@文件>']
```
- 默认以本机节点名作为 `From_Node` 与 `Source`；
- 命令成功后输出生成的 `Task_ID`（如 `TASK-20261107-a1b2c3`）。

示例：
```bash
# 让工作机 mba 执行 echo 测试
lah task create --to mba --cap echo-test --text "ping test" --params '{"hello":"world"}'

# 让工作机 mba 调用本地 Agent 执行运维巡检
lah task create --to mba --cap ops-agent --text "检查生产数据库磁盘剩余空间与连接数"
```

### 2. 消费原路返回的结果队列 (`lah present --pop`)
从本机读取并消费属于当前节点发起的任务回执：
```bash
lah present --pop
```
- 如果队列为空，命令无输出并干净退出；
- 如果队列有回执，输出 JSON Lines（NDJSON），每行包含：
  - `task_id`：任务编号
  - `status`：状态（`completed` / `failed` / `rejected` / `input-required`）
  - `title`：任务标题
  - `target_node`：执行节点
  - `message`：节点输出的最新说明
  - `outcome`：执行结果摘要
  - `error`：错误日志（若失败）
  - `text`：中台格式化的易读摘要
- `--pop` 参数表示读取后从队列移除已读项，适合 Agent 轮询消费并直接向用户汇报。

### 3. 答复任务追问 (`lah task reply`)
当 `present_queue` 中收到某任务处于 `input-required` 时，使用原任务答复，促使目标节点原位恢复执行：
```bash
lah task reply --task <Task_ID> --text "<补充的信息或答复>"
```
示例：
```bash
lah task reply --task TASK-20261107-a1b2c3 --text "已确认，允许继续执行数据导出"
```

### 4. 查看任务详情与产物 (`lah task show`)
实时查看任务的当前状态、最后一条消息与关联的产物（Artifacts）：
```bash
lah task show <Task_ID>
```
输出包含：
- 任务标题、状态、目标节点、认领者、重试次数；
- 最新一条消息的正文内容；
- 产物列表（`Artifact_ID`、产物名称与描述）。

### 5. 检查节点与总线状态 (`lah doctor`)
查看当前环境、配置凭据、长连接状态以及本节点和全网在册的 Agent 能力：
```bash
lah doctor
```
