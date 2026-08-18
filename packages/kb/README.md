# KB

English | [中文](README.zh.md)

The knowledge-base capability family: a personal + team two-library knowledge system with one card spec, a promotion pipeline from personal drafts to the team reference pool, FTS5-first retrieval, governance, recap, telemetry, and MCP exposure. See the [design Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md).

## Packages and `ctx` keys

| Package | Owns | `ctx` key |
|---|---|---|
| [`kb-core/`](kb-core/README.md) | Card model, personal-library storage, promotion state machine, FTS5 search, incremental ingest, and the `kb_*` tools | `ctx.kb` |
