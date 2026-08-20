# Agent Note: dsh-kb milestone 6 — unified dual-library search and the deferred vector backend

Status: implemented

English | [中文](2026-08-19-dsh-kb-milestone-6-unified-search.zh.md)

## Problem

Milestones 1–5 closed the loop: personal library, knowledge packs, team governance, recap, the web workbench, and read-only MCP exposure. The search surface still covers only the personal library — `kb_search` and the MCP `search_cards` tool describe themselves as personal-only, and the team reference pool is reachable only through `kb_team_read` and pack injection. The design's kb-search upgrade path (§4.4) is the milestone-6 job: unify retrieval over both libraries, and decide the vector/RAG backend's scope with its trigger conditions.

## Decision

**The unified index is one database per workspace root with a `(library, id)` composite key.** `CardIndex` gains a `library` column on the `cards` table and the `cards_fts` virtual table; the primary key becomes `(library, id)` so a personal draft and a team card that share an id never collide. `sync` accepts unified `SearchableCard` entries — the personal `CardFileInfo` shape plus a library tag; team entries carry no tier. `KbService.search` lists the personal store and, when `teamRepoPath` is configured, the team store, syncs both into the one index, and issues one BM25 query. A configured-but-broken team repository fails loud exactly like the other team operations; an unconfigured team library simply searches personal only. The degradation contract is unchanged in spirit and widened in coverage: when the index cannot open, the scan path covers both libraries with the same explicit `mode: 'scan'` note. The index schema version bumps to 2 (the table shape changed; incompatible databases reset in place).

**`SearchHit` gains `library: CardLibrary`, and `tier` is `CardTier | 'team'`.** The library discriminates where a hit lives; a team card has no personal tier, so its hit carries the sentinel `'team'` (documented as the team-library marker, never a tier). The `kb_search` tool's output schema already types `tier` as a string, so the payload change is additive (`library` becomes a required hit field); the `tier` filter's enum stays P0–P3, which explicitly excludes team cards — a filter that cannot apply to the team library is not silently dropped. The `kb_search` tool description updates from 检索个人知识库 to 个人 + 团队, and the render shows the library face; the MCP `search_cards` tool passes the same `SearchOutcome` through unchanged in shape and updates its render.

**The vector/RAG backend is deferred with trigger conditions.** A real vector backend needs an external embedding provider (a network/LLM dependency that is not keyless-testable), and the design's trigger — past ~500 team cards or long-form semantic retrieval — is not present. A self-contained deterministic surrogate (for example a local n-gram or FTS5 `trigram` index) would not deliver semantic retrieval and would add a second retrieval path with no consumer. The provider slot already exists: `KbService.search` behind `CardIndex`/`scanSearch` with the degradation contract as its invariant; a future vector provider is a `CardIndex`-shaped implementation behind the same method. The trigger conditions and the provider slot are recorded in the README, not re-engineered this milestone.

## Alternatives considered

**Two per-library indexes queried and merged separately.** Rejected: the merge needs cross-library score normalization and a second sort pass, and the degradation contract would need per-library modes; one composite-keyed index keeps BM25 ranking and filters in a single query.

**Give team cards a synthetic tier (for example `T`).** Rejected: the team library has no tiers (the L1–L4 levels are a future schema evolution), and inventing one for the hit shape would smuggle a schema promise into the wire type. The `'team'` sentinel on the hit's tier field plus the explicit `library` discriminator states exactly what exists.

**Ship a local deterministic "vector" backend now.** Rejected: it would be an n-gram surrogate that neither improves CJK substring recall (the char-split already covers it) nor delivers semantic retrieval, and it would add a retrieval path with no consumer — the same "no current owner and need" test the milestone-5 MCP seam applied.

## Consequences

`packages/kb/kb-core/src/search.ts` gains the unified entry type (`SearchableCard`), the `(library, id)` key, the team-aware scan path, and the widened `SearchHit`; `KB_SEARCH_SCHEMA_VERSION` bumps to 2. `KbService.search` lists and syncs both libraries; the `kb_search` tool and the MCP `search_cards` render + schema update (additive `library` hit field, personal+team description). The knowledge-pack selection (`selectPackCards`) reads the `list()` faces, not the index, so injection is unaffected. Tests: the search spec covers the unified sync/search/scan/filters and the team-tag collision; the loader-composition spec drives a real personal + team search through the tool; per-file coverage stays 100%. Docs update: the search contract section in `docs/subsystems/kb.md`, the kb-core README's search paragraph, and the vector-backend limitation gains its trigger conditions.
