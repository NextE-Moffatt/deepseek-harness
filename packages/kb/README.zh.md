# KB

[English](README.md) | 中文

知识库能力族：个人 + 团队双库知识系统，一套卡片规范，从个人草稿到团队引用池的晋升管线，FTS5 优先检索、治理、复盘、记账与 MCP 暴露。设计见 [Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md)。

## Packages and `ctx` keys

| Package | Owns | `ctx` key |
|---|---|---|
| [`kb-core/`](kb-core/README.md) | 卡片模型、个人库存储、晋升状态机、FTS5 检索、增量采集与 `kb_*` 工具 | `ctx.kb` |
