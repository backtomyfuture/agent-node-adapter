// 事件接收：飞书长连接（WebSocket）订阅多维表格记录变更事件。
// 与参考实现（Python lark-oapi 版）同一事件：drive.file.bitable_record_changed_v1。
// 门铃语义：事件本身不携带任务处理逻辑，只负责「叫醒」内核立刻扫表；
// 事件内容不做解析（只按 Base token 粗筛），丢事件由内核的低频对账兜底。
// 配置了 doorbellFile 时把原始事件逐行追加进去——同一机器上有其他消费者
// （如另一个守护进程）盯着这个文件时，两边互相叫醒，谁收到事件都不丢唤醒。

import fs from "node:fs";
import * as Lark from "@larksuiteoapi/node-sdk";

const EVENT_TYPE = "drive.file.bitable_record_changed_v1";

export class FeishuEventReceiver {
  constructor({ appId, appSecret, baseToken, doorbellFile, onEvent, onStatus, log }) {
    this.baseToken = baseToken;
    this.doorbellFile = doorbellFile;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.log = log ?? (() => {});
    this.appId = appId;
    this.appSecret = appSecret;
  }

  handle(data) {
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
    const dispatcher = new Lark.EventDispatcher({}).register({
      [EVENT_TYPE]: async (data) => this.handle(data),
    });
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
}
