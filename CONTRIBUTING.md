# Contributing

## 仓库结构速览

- `bin/` `src/`：节点适配器（Node >= 20，唯一运行时依赖是飞书官方 SDK）。
- `hub/`：枢纽参考实现（Python 3，仅接收端依赖 `lark-oapi`）。
- `docs/`：规范性文档。**`docs/standard.md` 是标准**，实现与标准冲突时
  先改标准、再改实现，并在 CHANGELOG 记一笔。
- `schema/`：Base 结构快照与生成器。

## 改动纪律

- **改了 Base 表结构**：先在线上 Base 改，再跑
  `python3 schema/generate_schema.py`（凭据走环境变量，见脚本头），
  把 `schema/base-schema.json` 与 `docs/base-schema.md` 的更新与代码
  一起提交——文档以线上字段为准生成，不要手改生成文件。
- **改了节点行为**：`node --check` 过全部源文件；有条件时用
  `hub-node doctor` 对示例配置与真实配置各跑一遍。守护进程是薄壳：
  新能力优先用命令模板（commands.json）表达，不要往内核里塞执行器。
- **凭据红线**：任何真实凭据、Base token、table_id、个人 open_id 都不
  得进仓库；示例一律用占位符，真实值走 env 文件（已 gitignore）。
- **提交信息**：一行说清动了什么、为什么；版本发布时同步 bump
  `package.json`、`package-lock.json` 与 `src/kernel.mjs` 的
  DAEMON_VERSION，并在 CHANGELOG 顶部加条目。

## 设计问题去哪讨论

先读 `docs/architecture.md` 的核心决策——多数「为什么不这样做」都在
那里有答案；新提案请开 issue 说明场景与代价。
