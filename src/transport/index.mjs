// 唤醒器（Waker）工厂。守护进程侧只有两种入站唤醒：ws 与 poll。
// webhook / automation 不在这里：那是飞书自动化向外部节点出站 POST，
// 本进程不监听端口，也不主动推送。
//
// 契约（hub 与 node 共用，保持稳定）：
//   createWaker(cfg, { onWake, extraHandlers, log, onStatus })
//   → { mode: "ws" | "poll", start(onWake), stop(), wait(isAwake) }
//
// - mode：选中的传输。"ws" 在 AgentCards 上仍登记为 Receive_Mode=event，"poll" 登记为 poll。
// - start(onWake)：开始监听。onWake 可省略，则用工厂参数里的 onWake。
//   有唤醒时调用 onWake({ source })，source 为 "event"（长连接）或 "doorbell"（门铃文件变大）。
//   回调只负责把「有新东西」记住；不要在回调里清标志。
// - stop()：停监听。之后不再调用 onWake。
// - wait(isAwake)：扫表之后的等待。isAwake() 为真，或等到本模式的上限，就返回。
//   这里不清除唤醒标志。清零点必须在扫表之前（ECHO-004）：扫表期间到达的唤醒要留到下一轮立刻再扫。
//   ws 已连通或门铃文件已存在时，上限是 sweepSec（默认 900）；否则是 pollSec（默认 45）。
//   断线不补发事件，所以等满 sweepSec 仍会返回，让调用方做对账扫表。
// - extraHandlers：仅 ws 使用，见 ws.mjs 文件头。poll 忽略它。
// - onStatus(up)：可选。长连接就绪/断开时回调，语义与原 FeishuEventReceiver.onStatus 相同。
//
// 选择规则与重构前的节点守护进程一致，没配新字段时不变：
//   events === false 且没有 doorbellFile → poll；其余 → ws（events 缺省视为开）。
// hub 角色例外：审批卡回调只经长连接送达，role === "hub" 时强制 ws，即使 events 为 false。

import { createPollWaker } from "./poll.mjs";
import { createWsWaker } from "./ws.mjs";

export function wakerMode(cfg) {
  if (cfg?.role === "hub") return "ws";
  if (cfg?.events === false && !cfg?.doorbellFile) return "poll";
  return "ws";
}

export function createWaker(cfg, opts = {}) {
  const mode = wakerMode(cfg);
  if (mode === "ws" && cfg?.role === "hub" && cfg?.events === false) {
    (opts.log ?? (() => {}))("hub 角色必须保持长连接，已忽略 events:false");
  }
  if (mode === "poll") return createPollWaker(cfg, opts);
  return createWsWaker(cfg, opts);
}
