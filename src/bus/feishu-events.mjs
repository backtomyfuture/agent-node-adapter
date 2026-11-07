// 长连接门铃的实现已迁到 src/transport/ws.mjs。
// 本文件只保留旧导入路径，避免还在引用 FeishuEventReceiver 的代码断开。

export { FeishuEventReceiver } from "../transport/ws.mjs";
