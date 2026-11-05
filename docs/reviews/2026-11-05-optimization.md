# lark-a2a-hub 第二评审：核实结论与优化路线

日期 2026-11-05。逐条回到源码核实 `/tmp/ana-research/review.md`（30 项），行号按当前工作树。只读仓库，未执行任何联网或真实 Base 操作。

**核实统计：确认 25｜部分成立 5｜误报 0｜新增 8**（另有 3 条新证据并入原条目：01、13、27）。
严重度调整 6 条：07、09、15 高→中；23、25、28 中→低。调整后原 30 项为：高 14、中 12、低 4；新增 8 条为高 1、中 3、低 4。

## 一、逐条核实（路径相对仓库根）

| # | 判定 | 级别 | 理由与证据 |
|---|---|---|---|
| 01 | 确认 | 高 | `src/kernel.mjs:379-386` 有文本兜底；并且任意一条 approve 就放行，不校验 From_Node/Role，也不绑定 Status_Msg 或"最新决定"。节点上的 Agent 拿着 lark-cli 就能替别的任务写批准。 |
| 02 | 确认 | 高 | `hub/event_receiver.py:135-145` 只读 `action.value`，不比对操作者与 `HUB_OWNER_OPEN_ID`（`hub/hub_api.py:26`）。卡片只发机主私聊（`approval_watcher.py:66`），能缓解，但不能当作鉴权。 |
| 03 | 确认 | 高 | 只认任务行（`kernel.mjs:475`），`side_effect` 只写进名片（`:315`）。标准 §8.3 第 3 点已允许"节点自有红线优先"，加本地下限不违标准。 |
| 04 | 确认 | 高 | `kernel.mjs:190-208` 把指令文本和参数原样拼进 prompt；示例模板带 `--dangerously-skip-permissions`（`config/commands.example.json:17,25`）。AGENTS.md 已承认这个缺口。 |
| 05 | 确认 | 高 | `bin/hub-node.mjs:36-38` 没有实例锁，回读只比 `Claimed_By=node`（`kernel.mjs:404-405`）。launchd 和手动 daemon 同时在跑时，两边都能通过回读校验。 |
| 06 | 确认 | 高 | `run()` 只在 `:580` 取一次快照；`execute` 认领前（`:401`）和收尾时（`:422,438,445`）都不重读状态。前一个任务执行期间被 canceled 的任务，仍会被改回 working 或 completed。 |
| 07 | 部分成立 | 高→中 | 节点确实不读 Idempotency_Key（全仓 grep 为零）。但标准 §8.4 只写了"建单靠幂等键"，节点侧查重的语义和范围都没定义；参考枢纽也不建单，所以这是承诺缺口，不是现网高危。 |
| 08 | 确认 | 高 | `reclaimStale` 只在 `:564` 调用一次；`getParams`（`:410`）位于心跳和 try 之外，抛错后任务停在 working、没有心跳，再也不会回收。和 16 叠加会更严重：崩溃后 launchd 立刻重启，此时心跳不足 20 分钟，不会被回收。 |
| 09 | 部分成立 | 高→中 | 续跑确实绕过 handleTask（`:497-509`）。不过 carrier 离线或命令被删时，`runCommand`/`execViaCarrier` 会抛错并按失败处理，不是静默执行；审批也已在暂停前通过。真正被绕过的只有撤销 Dispatchable、Hop 被改、本地审批下限（03）这几项。 |
| 10 | 确认 | 高 | `kernel.mjs:286-287` 的 stdin 型模板直接走 `runShell`，违反 DESIGN §9 的铁律。 |
| 11 | 确认 | 高 | 先写消息、后写 Parts（`:138-145`）。Parts 写失败后进入通用 catch，任务回到 submitted，下一轮被 `:470` 关成没有正文的 completed。`askApproval` 在 `:391` 见到已有 auth_request 就直接 return，任务永远卡在 submitted。 |
| 12 | 确认 | 高 | 范围比原报告大：命令成功后，`registerArtifact`/`writeRun`/`writeMessage` 任何一次写表失败（`:419-424`）也会落进 `:434-442` 的重试，重新执行业务。`stdout="null"` 时 `:276` 抛 TypeError。 |
| 13 | 部分成立 | 高 | 批准路径会清 Presented（`event_receiver.py:171`），原报告没提。但答复续跑路径和节点都不清。另有新证据：`_queue_scan` 按 record_id 永久去重（`:81-95`），即使 Presented 被清，任务也进不了队列，除非消费者删掉队列行。 |
| 14 | 确认 | 高 | `present_results.py:41` 用了 `--limit 200`。本机 lark-cli 帮助写明 json 格式上限 200、单次请求，需要 `--offset` 续读。 |
| 15 | 部分成立 | 高→中 | `sh -c` 只有一条简单命令时会直接 exec 到命令本身，所以示例里的单命令模板超时能杀到本体。复合命令、Agent 派生的子进程会漏杀，`close` 还会被孤儿进程拖住（`kernel.mjs:228-236`，`carrier.mjs:91-99`）。 |
| 16 | 确认 | 高 | 两处都没有 `p.stdin.on("error")`（`kernel.mjs:237`，`carrier.mjs:100`）；`bin/hub-node.mjs:27` 只兜 unhandledRejection。触发条件是输入超过管道缓冲（约 64KB）且执行器不读 stdin 就退出。 |
| 17 | 确认 | 高 | 比原报告更糟：`install.sh:40-43` 先种了 node.json，于是 `setup.mjs:229-231` 在 `--yes` 下直接返回 4，交互模式默认回答 N。echo 路径 `../src` 是相对 `~/.hub-node` 解析的，指错；lan-exec 让 doctor 失败（`doctor.mjs:100-101`），setup 中止，自启不会注册。 |
| 18 | 确认 | 中 | `kernel.mjs:369-372` 回收时只累加，没有上限。标准 §8.4 也没写回收预算，要先补标准。 |
| 19 | 确认 | 中 | `:573-576` 只登记一次。补充：删掉的能力，名片仍是 Dispatchable=Yes。README:71 写"每轮自动重读"，容易误导。 |
| 20 | 确认 | 中 | `:86-88` 解析失败就清空能力表，接着 `:479-482` 把任务拒成终态 rejected，无法撤回。 |
| 21 | 确认 | 中 | `:307-311` 跳过已有名片；`:332-333` 先改缓存，再写表。 |
| 22 | 确认 | 中 | `:199,503-506` 只带最后一个问题之后的答复，问题原文不进 prompt。 |
| 23 | 确认 | 中→低 | FilePart 输入确实被丢（`:103-115`），但参考枢纽从不在 instruction 里写 FilePart，属于能力缺口。 |
| 24 | 确认 | 中 | 卡片的"上下文"栏显示的是 Context_ID（`approval_watcher.py:30,44`）；auth_request 正文也只有标题（`kernel.mjs:392-393`）。 |
| 25 | 确认 | 中→低 | 和标准 §8.1 第 2 步不符，但执行中的状态已经由 working+Heartbeat_At 表达，影响限于台账审计。 |
| 26 | 确认 | 中 | `doctor.mjs:97-98` 只 ping 了一下就宣称可用；README:76-88 没有转述 DESIGN §9 注记④ 的限定。 |
| 27 | 确认 | 中 | 只在事件到达时扫描（`event_receiver.py:103-120`）。补充：hub-integration.md:20 承诺的"陈旧任务告警"也没有实现，而节点只回收 `Claimed_By` 是自己的任务（`kernel.mjs:361`），死节点的任务没人管。 |
| 28 | 部分成立 | 中→低 | 脚本头注释（`:5`）约定由 stdout 的 OK/REPAIRED/BROKEN 表达结果，所以 BROKEN 时 exit 0 符合这个约定。真问题只有一处：`:9-11` 的 cp/start 失败了仍打印 REPAIRED。 |
| 29 | 确认 | 中 | `setup.mjs:167` 输入时回显明文；另有 `--app-secret` 命令行参数（`:33`），会留在 ps 和 shell 历史里。 |
| 30 | 确认 | 低 | 只有 `package.json` 落后（0.3.0）；`package-lock.json:3` 和 DAEMON_VERSION 都是 0.4.1。 |

## 二、新增问题（第一评审员漏掉的）

- **N1 [高] 每读一条消息都扫全表**：`listMessages` 每次拉完整个 Messages 表，`listParts` 每读一条消息就拉一次整个 Parts 表（`kernel.mjs:94-101`）。`authApproved`、`instructionText`、`getParams`、`buildPrompt` 和 `writeMessage` 的计数都重复走这条路，一个任务要做几十次全表分页。表一大（hub-integration.md:104 写了 2 万行上限）就会触发 429、拖慢主循环，还会放大 11/12 的半写入。
- **N2 [中] POST 重试不幂等**：`feishu.mjs:34-60` 对网络错误和 5xx 一律重放 `createRecord`（`:77-79`），但不带 `client_token`。请求其实已经成功、只是响应丢了时，会写出重复的 Messages/Parts 行，而这两张表只追加、不可删。
- **N3 [中] 消息编号靠计数，顺序靠列表返回序**：Msg/Artifact/Run 的 ID 都是"现有行数+1"（`kernel.mjs:136-137,153-155,167-168`，`event_receiver.py:147-148`），节点和枢纽并发写时会撞号。"首条 instruction""question 之后的 answer""最后一条消息"都依赖 API 的返回顺序（`kernel.mjs:120,499-506`，`present_results.py:92`），没有按 Seq 或 Created_At 排序。
- **N4 [中] `params.timeout_sec` 没有上下界**：`kernel.mjs:263` 不做范围限制，任务可以要求极长的超时，心跳会一直续命，串行主循环被长期占住；非数字值会变成 NaN。把它收紧到本地上限属于缩小例外，不违反 AGENTS.md。
- **N5 [低] 心跳与主流程同表并发写**：`setInterval` 心跳（`:412-415`）和收尾时的 `updateRecord` 可能并发，违反"同表写串行"；`clearInterval`（`:452`）也拦不住已经发出的那次心跳，它会在终态之后改写 Heartbeat_At。
- **N6 [低] 标准与实现不一致**：标准 §8.3 写的是"认领后写 auth_request"，实现和 AGENTS.md 都是 `submitted→auth-required`，不经认领。
- **N7 [低] 发卡状态只在最后落盘**：`approval_watcher.py:58-70` 中途任一 `send_card` 抛错，整批状态都不保存，下次会重复发卡；`USER_OPEN_ID` 为空时不提前报错。
- **N8 [低] 配置错误导致重启风暴**：`bin/hub-node.mjs:37` 的 `loadConfig` 抛错时进程直接退出，launchd 的 `KeepAlive`（`service.mjs:64`）会反复拉起。应该打一条可读日志后退出码非零并退避，而不是无声刷屏。

## 三、优化路线（已合并去重）

标注说明：【标准先行】表示必须先改 `docs/standard.md` 并在 CHANGELOG 记一笔；【可并行】表示可以和其他项同时开工。

### P0 必须先修（安全边界与数据正确性）

**P0-1 状态写守卫、单实例、回收常态化**（06、05、08、N5）
- 文件：`src/bus/feishu.mjs`、`src/kernel.mjs`、`bin/hub-node.mjs`。
- 改法：
  - 给 `FeishuBus` 加 `getRecord(table, id)`。
  - 认领前重读，只有 `submitted`/`input-required` 才写 working；每次写状态前也重读，遇到终态或 `Claimed_By` 已不是本节点就放手并记日志。
  - 在配置目录用 `fs.openSync(lock, "wx")`＋pid 存活检查做单实例锁，失败就记日志后退出码非零。
  - `getParams` 移进 try，心跳在认领成功后立即启动。
  - `reclaimStale` 并入每次对账扫表（每 sweepSec 一次）。
  - 收尾前先 await 在途的心跳。
- 验证：写临时脚本，用内存 FakeBus 覆盖三种场景：执行中被取消、双实例、getParams 抛错，用完删除。再跑一遍 `node --check`。
- 依赖：无。它是 P0-2 和 P1-5 的前置。

**P0-2 执行与提交分离，失败不重做副作用**（11、12、N2）【标准先行：§4/§8.1 明确"执行成功但回执无效或提交失败"不计入重试】
- 文件：`src/kernel.mjs`、`src/bus/feishu.mjs`、`docs/standard.md`。
- 改法：
  - 命令跑完后，先把回执写进本地 `<configDir>/outbox/<Task_ID>.json`（600），再分步提交。
  - 提交失败只重试提交，不重新执行；回执无法解析时置 `failed`＋notice，并保留原始输出摘要。
  - 写 Parts 前按 Part_ID 查重补齐；对账时遇到"有 result 但缺 Parts"，从 outbox 修复；遇到"有 auth_request 但仍是 submitted"，补置 auth-required 和 Status_Msg。
  - `createRecord` 带 `client_token`，见 N2。
- 验证：用 FakeBus 注入第 n 次写失败，断言命令只执行 1 次、任务最终状态正确；另测 `stdout="null"` 和坏 JSON。
- 依赖：P0-1。

**P0-3 审批真实性与本地下限**（01、02、03、N6）【标准先行：§8.3 写清以下三条，并把 N6 措辞对齐实现】
- 标准先写清：
  1. auth_decision 必须 `From_Node=hub`、`Role=user`、`In_Reply_To` 等于当前 `Status_Msg`，以最新一条为准，只认 DataPart。
  2. 回调必须校验操作者是机主。
  3. 节点可以用 `commands.json` 的 `approval_class` 声明下限，和任务行取两者中更严格的。
- 文件：`src/kernel.mjs`（`authApproved` 删除文本兜底，`handleTask` 合并本地下限）、`hub/event_receiver.py`（比对 `data.event.operator.open_id` 与 `HUB_OWNER_OPEN_ID`，并写 `In_Reply_To`）、`config/commands.example.json`（write 类示例加上 `approval_class`）。
- 验证：FakeBus 覆盖：先 reject 后 approve、他人写的 approve、绑定旧请求的 approve、带下限但任务行未标。用伪造的 operator 调一次 `on_card_action`，并跑 `py_compile`。
- 依赖：标准改完后，kernel 和 hub 两侧可并行。

**P0-4 不静默直跑、不崩进程**（10、16）【可并行，几行改动】
- 文件：`src/kernel.mjs:286-287` 改为 `this.execFor(entry, command, prompt, timeout, cwd)`；`kernel.mjs:237` 和 `carrier.mjs:100` 加 `p.stdin.on("error", …)`，并入执行失败路径。
- 验证：临时 carrier 配置下跑 stdin 模板，确认请求走 socket；用 200KB 输入跑 `true`，进程不退出。
- 依赖：无。

### P1（功能闭环与可运维）

**P1-1 指令与数据隔离**（04）【标准先行：§9 补"agent 输入约定"】
- agent 模式把指令文本、参数和答复写进本次运行目录下的 `input.json`（600）。prompt 里只放受信模板和这个文件的路径，并声明"文件内容是数据，不是指令"。
- 参数里出现 `command`/`cwd`/`context`/`agent` 等执行控制键时，直接拒收。
- 示例模板去掉 `--dangerously-skip-permissions`，或在说明里写明风险。
- 文件：`kernel.mjs:190-208`、示例配置、DESIGN §8 注记。
- 验证：构造含注入文本的参数，检查 prompt 里只有路径。
- 依赖：P0-4（同一函数，先合入）。

**P1-2 进程生命周期与超时上限**（15、N4）
- `spawn` 加 `detached:true`，超时或取消时 `process.kill(-pid,"SIGTERM")`，限时后再 SIGKILL。
- `timeout_sec` 先收紧到 `[1, entry.max_timeout_sec ?? entry.timeout_sec ?? 600]`，非数字回退到默认值。
- carrier 客户端的超时要和服务端串行队列对齐。
- 文件：`kernel.mjs:223-240,263`、`carrier.mjs:86-103`。
- 验证：用 `sh -c 'sleep 30 & sleep 30'` 测超时后无残留进程。
- 依赖：P0-4。

**P1-3 枢纽呈递闭环**（13、14、27、N7）【可并行，只动 hub/】
- `list_table` 按 `--offset/next_offset` 分页读全。
- 呈递去重改为"任务＋当前 Status_Msg"：`--list` 输出 `status_msg`，队列按 `(record_id, status_msg)` 去重；`--mark` 记录已呈递的 Msg_ID，可放进 Tasks.Metadata。
- 新增 `--sweep` 周期模式，配 systemd timer 示例（20 分钟），同时报告陈旧 working 任务。
- watcher 每发一张卡就保存一次状态，`USER_OPEN_ID` 为空时启动即报错。
- 文件：`hub/present_results.py`、`event_receiver.py`、`approval_watcher.py`、`hub/README.md`、`docs/hub-integration.md`。
- 验证：用 mock 的 lark-cli 输出 250 行、has_more 的数据，测一遍完整的问答续跑后最终结果能二次入队。
- 依赖：无。如果呈递去重改用 Metadata，要在标准 §8.5 补一句。

**P1-4 安装到 setup 的首装路径**（17、29、30）【可并行】
- `install.sh` 不再种 node.json 和 commands.json（setup 负责生成）；或者 setup 识别"仍是示例占位符"的 node.json，直接覆盖。
- echo 种子用绝对路径（沿用 `setup.mjs:252`）。
- Secret 输入关闭回显，删掉 `--app-secret` 参数，改为从 `HUB_APP_SECRET` 环境变量或文件读取。
- 发版时同步 `package.json` 版本。
- 验证：用临时 `HUB_NODE_HOME` 跑 install 和 `setup --yes --base … --node …`（打桩总线或只跑到 doctor），确认能力表只有 echo。
- 依赖：无。

**P1-5 续跑共用闸门与回收预算**（09、18）【标准先行：§8.4 写明"心跳回收计入 Retry_Count，超过上限就 failed＋notice"】
- 把 handleTask 的熔断、本地审批下限、能力和 Dispatchable、carrier 检查抽成 `preflight(task)`，首次派发和续跑都调用。
- `reclaimStale` 超限时改为置 failed＋Runs＋notice。
- 文件：`kernel.mjs:359-377,456-511`。
- 验证：FakeBus 测撤销 Dispatchable 后的续跑、Retry_Count=2 时的回收。
- 依赖：P0-1、P0-3。

**P1-6 能力表热更新与名片一致性**（19、20、21）
- 解析失败时保留上一版能力表、暂停新派发，不再拒收任务。
- 用文件 mtime 或哈希检测变更，变化后串行地重新对账名片：新增能力、删除的能力置 `Dispatchable=No`。
- 启动时强制校准 carrier 名片；写表成功之后再更新缓存。
- 文件：`kernel.mjs:83-90,295-344,573-579`、README:71。
- 验证：写坏 JSON 后任务仍是 submitted；增删能力后名片随之变化。
- 依赖：P0-1（同文件，顺序合入）。

**P1-7 降低全表扫描**（N1、N3）
- 每轮扫表只拉一次 Messages/Parts，建 `Task_ID→msgs`、`Parent_ID→parts` 索引并在本轮复用；或者改用 `records/search` 加 filter。
- 读消息按 Msg_ID 序号或 Created_At 排序。
- 编号用"当前最大序号+1"，配合 `client_token`，并在标准 §3 示例里说明。
- 验证：FakeBus 记录 API 调用次数，单任务的读请求降到常数级。
- 依赖：P0-2（共用 `writeMessage`）。

**P1-8 审批卡展示待执行内容**（24）
- auth_request 的正文带上指令摘要，以及脱敏、截断后的参数。
- 卡片读 `Status_Msg` 指向的 Parts，代替原来显示的 Context_ID。
- 文件：`kernel.mjs:389-396`、`approval_watcher.py:29-44`。
- 依赖：P0-3、P1-1（需要确定哪些参数可以展示）。

### P2（承诺补齐与一致性）

- **P2-1 节点侧幂等**（07）【标准先行】：§8.4 先定义"同一 Idempotency_Key 在非 failed/canceled 状态下只执行一次，节点遇重复就 rejected＋notice，并指向原任务"，再在 handleTask 里查重。依赖 P1-7 的索引。
- **P2-2 多轮上下文**（22）：prompt 和 json 信封按顺序带入全部 question/answer 对，可走 P1-1 的 `input.json`。依赖 P1-1。
- **P2-3 FilePart 输入**（23）：信封加 `_hub.files: [{uri, name, mime}]`；agent 模式写进 `input.json`。依赖 P1-1。
- **P2-4 Runs 起止**（25）：认领后先建 Run 行并写 Latest_Run，结束时 `updateRecord` 关行。按 §8.1 实现，标准不用改。依赖 P0-1。
- **P2-5 doctor 与 README 限定**（26）：把"socket 在线"和"局域网可达（未验证）"分开报告；`hub-node doctor --probe <host:port>` 经 carrier 做一次只读 TCP 探测；README 补上 §9 注记④ 的限定。
- **P2-6 自愈脚本**（28）：cp 失败时输出 BROKEN；启动后用 `is-active` 复核。
- **P2-7 配置错误退出**（N8）：`loadConfig` 失败时打印可读原因、睡眠退避后再退出码非零，避免 KeepAlive 刷屏。

## 四、并行与顺序

- **轨道 A（kernel 主干，串行）**：标准改动（§4/§8.1/§8.3/§8.4，一次改完、一条 CHANGELOG）→ P0-1 → P0-2 → P1-5 → P1-6 → P1-7 → P2-1/P2-4。
- **轨道 B（执行层）**：P0-4 → P1-1 → P1-2 → P2-2/P2-3。和轨道 A 在 `kernel.mjs` 的不同函数上工作，按 PR 顺序 rebase 即可。
- **轨道 C（hub/，和节点完全并行）**：P0-3 的 hub 侧 → P1-3 → P1-8 的卡片部分 → P2-6。
- **轨道 D（装机，完全并行）**：P1-4 → P2-5 → P2-7。
- **必须先改 docs/standard.md 的**：P0-2、P0-3（含 N6）、P1-1（§9）、P1-5（§8.4）、P2-1（§8.4）；P1-3 若改用 Metadata 记录呈递，也要补 §8.5。
- **不需要动标准的**：P0-1、P0-4、P1-2、P1-4、P1-6、P1-7（只是落实 §3、§8.4 已有的要求）、P2-4 到 P2-7。
- 每项验收都按 AGENTS.md 的命令跑：逐文件 `node --check`、`py_compile`、echo 冒烟；行为验证用临时 FakeBus 脚本，用完删除。不新增测试框架。
