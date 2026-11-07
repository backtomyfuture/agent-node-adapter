// ws 唤醒器：飞书 SDK 长连接订阅多维表格记录变更，只当门铃，不解析事件内容。
// 丢事件由调用方的低频对账兜底（默认 15 分钟）。门铃文件（doorbellFile）的
// 追加与「文件变大就叫醒」都在本文件，不在内核里。
//
// extraHandlers 契约（稳定，hub 依赖它收审批卡）：
//   形状是 { [事件类型]: async (data) => {} }。
//   与 bitable 变更事件一起注册进同一个 SDK EventDispatcher，从而共用一条长连接。
//   hub 角色用键 "card.action.trigger" 注册卡片回调；审批回调只能从这条长连接进来，
//   本进程不开回调地址。
//   - 这些处理函数原样注册，本模块不包一层、也不替它们调用 onWake。
//     卡片回调要不要接着扫表，由处理函数自己决定。
//   - "drive.file.bitable_record_changed_v1" 由本模块占用为门铃。
//     extraHandlers 里若带了同名键，门铃处理完后再调用它，不会被覆盖掉。
//   - 非函数的值会跳过并记一条日志，避免一个坏配置弄断整条连接。

import fs from "node:fs";
import * as Lark from "@larksuiteoapi/node-sdk";

const EVENT_TYPE = "drive.file.bitable_record_changed_v1";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export class FeishuEventReceiver {
  constructor({ appId, appSecret, baseToken, doorbellFile, onEvent, onStatus, log, extraHandlers }) {
    this.baseToken = baseToken;
    this.doorbellFile = doorbellFile;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.log = log ?? (() => {});
    this.appId = appId;
    this.appSecret = appSecret;
    this.extraHandlers = extraHandlers ?? {};
    this._stopped = false;
  }

  handle(data) {
    if (this._stopped) return;
    const ev = data?.event ?? data ?? {};
    const fileToken = ev.file_token ?? ev.fileToken;
    if (fileToken && this.baseToken && fileToken !== this.baseToken) return;
    if (this.doorbellFile) {
      try {
        const rec = { ts: new Date().toISOString(), type: EVENT_TYPE, event: ev };
        fs.appendFileSync(this.doorbellFile, JSON.stringify(rec) + "\n");
      } catch (e) {
        this.log("doorbell append failed: " + e.message);
      }
    }
    this.onEvent?.();
  }

  start() {
    const handles = {};
    for (const [key, fn] of Object.entries(this.extraHandlers)) {
      if (typeof fn === "function") handles[key] = fn;
      else this.log(`event receiver: ignore extra handler ${key} (not a function)`);
    }
    // 门铃后写。同名键先留给上面的用户函数，再包一层，避免 register 的覆盖警告把门铃弄丢。
    const userBitable = handles[EVENT_TYPE];
    handles[EVENT_TYPE] = async (data) => {
      this.handle(data);
      if (typeof userBitable === "function") await userBitable(data);
    };
    const dispatcher = new Lark.EventDispatcher({}).register(handles);
    this.ws = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.WARN,
      onReady: () => {
        this.log("event receiver: ws connected");
        this.onStatus?.(true);
      },
      onError: (err) => {
        this.log("event receiver: ws error " + (err?.message ?? err));
        this.onStatus?.(false);
      },
      onReconnecting: () => this.log("event receiver: reconnecting"),
      onReconnected: () => {
        this.log("event receiver: reconnected");
        this.onStatus?.(true);
      },
    });
    // start() 返回的 Promise 只在连接关闭时才 settle，不 await。
    Promise.resolve(this.ws.start({ eventDispatcher: dispatcher })).catch((e) => {
      this.log("event receiver: start failed " + e.message);
      this.onStatus?.(false);
    });
  }

  stop() {
    this._stopped = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws?.close) return;
    try {
      // force 走 terminate，避免半开握手的 error 事件把进程打崩，也避免 ping 定时器挂住事件循环。
      ws.close({ force: true });
    } catch (e) {
      this.log("event receiver: stop failed " + e.message);
    }
  }
}

export function createWsWaker(cfg, opts = {}) {
  return new WsWaker(cfg, opts);
}

class WsWaker {
  constructor(cfg, { onWake, extraHandlers, log, onStatus } = {}) {
    this.mode = "ws";
    this.cfg = cfg ?? {};
    this.onWake = onWake;
    this.extraHandlers = extraHandlers ?? {};
    this.log = log ?? (() => {});
    this.onStatus = onStatus;
    this._wsUp = false;
    this._stopped = false;
    this._started = false;
    this.receiver = null;
  }

  start(onWake) {
    if (typeof onWake === "function") this.onWake = onWake;
    if (this._started) return;
    this._started = true;
    this._stopped = false;
    // hub 必须连着；node 在 events 不为 false 时才连。纯门铃（events 关、但有门铃文件）只盯文件。
    const connect = this.cfg.role === "hub" || this.cfg.events !== false;
    if (!connect) return;
    // 凭据挂在总线上（loadConfig 的回传对象不另抄一份）。直接构造时也可放在 cfg 上。
    const bus = this.cfg.bus ?? {};
    this.receiver = new FeishuEventReceiver({
      appId: this.cfg.appId ?? bus.appId,
      appSecret: this.cfg.appSecret ?? bus.appSecret,
      baseToken: this.cfg.baseToken ?? bus.baseToken,
      doorbellFile: this.cfg.doorbellFile,
      extraHandlers: this.extraHandlers,
      onEvent: () => {
        if (this._stopped) return;
        this.onWake?.({ source: "event" });
      },
      onStatus: (up) => {
        this._wsUp = up;
        this.onStatus?.(up);
      },
      log: this.log,
    });
    this.receiver.start();
  }

  stop() {
    this._stopped = true;
    this._started = false;
    if (this._wsUp) {
      this._wsUp = false;
      this.onStatus?.(false);
    }
    this.receiver?.stop();
    this.receiver = null;
  }

  _doorbellSize() {
    if (!this.cfg.doorbellFile) return -1;
    try { return fs.statSync(this.cfg.doorbellFile).size; } catch { return -1; }
  }

  // 与原 waitWake 同一节奏：先睡 1 秒再看标志，进入等待时才采样门铃大小和连接状态。
  // 不在这里清标志。门铃变大时补一次 onWake，让不走 wait() 的调用方也能收到。
  async wait(isAwake) {
    const start = this._doorbellSize();
    const eventDriven = this._wsUp || start >= 0;
    const maxWait = (eventDriven ? this.cfg.sweepSec : this.cfg.pollSec) * 1000;
    let waited = 0;
    while (waited < maxWait) {
      if (this._stopped) return;
      await sleep(1000);
      waited += 1000;
      if (this._stopped) return;
      if (isAwake?.()) {
        this.log("event: waking");
        return;
      }
      if (this.cfg.doorbellFile && this._doorbellSize() !== start) {
        this.onWake?.({ source: "doorbell" });
        this.log("doorbell: event arrived, waking");
        return;
      }
    }
  }
}
