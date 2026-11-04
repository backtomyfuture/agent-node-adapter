#!/usr/bin/env node
// echo 执行器（json 模式示例）：从 stdin 读任务信封，把参数原样回显到结果 JSON。
// 用途：验证节点全链路（认领 → 执行 → 回执）是否畅通，不做任何真实工作。
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const env = JSON.parse(input || "{}");
  const { _hub, ...params } = env;
  console.log(JSON.stringify({
    summary: `echo from node "${_hub?.task_id ?? "?"}": ` + JSON.stringify(params),
  }));
});
