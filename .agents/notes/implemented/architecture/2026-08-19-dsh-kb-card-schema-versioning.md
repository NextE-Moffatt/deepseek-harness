# Agent Note: dsh-kb card schema evolution — parser-as-authority, additive fields, index reset

Status: implemented

English | [中文](2026-08-19-dsh-kb-card-schema-versioning.zh.md)

## Problem

A knowledge card is Markdown plus YAML front matter, the one user-facing format shared by the personal and team libraries. The front-matter field set will evolve (the team library's L1–L4 levels and governance fields are the known candidates), and every existing card plus the FTS5 index must stay readable and searchable across the change. The open decision from the milestone-2 kickoff (待决项 5) is the versioning and migration strategy: how a field addition or removal lands without breaking existing cards, the index, or future parsers.

## Decision

**Card files carry no schema-version field; the parser is the version authority.** A file is a valid card exactly when the current parser accepts it. A version field would create a second authority that can disagree with the parser, and hand-edited Markdown files (the design's editing model) must stay valid without updating a version header. Store listing already reports per-file parse failures instead of dropping files, so an unparseable card is always visible, never silently skipped or auto-rewritten.

**Field evolution is additive-only, and unknown keys keep failing loud.** A new field ships as an optional front-matter key, parsed by the parser in the same change that introduces it; existing cards without the key read with the field absent, and `kb_write` supplies the default when one applies (the 有效期 → `now + cardTtlDays` default is the existing pattern). Renaming, removing, retyping, or making an existing key required is a breaking change that requires an explicit migration pass that rewrites card files — the pre-release stance prefers the correct foundation over compatibility shims, and an old parser silently misreading a new file is the failure mode the loud rejection exists to prevent. The unknown-key rejection stays: a card carrying a not-yet-known key fails loud rather than being re-serialized without it on the next write (which would silently drop data the user put there).

**Index evolution is a schema bump plus the existing reset-in-place.** The FTS5 database at `kb/.kb-index.sqlite` keeps `KB_SEARCH_SCHEMA_VERSION` (currently 1), `PRAGMA application_id`, and `PRAGMA user_version`; opening an index whose version differs from the current one drops and recreates the tables, and the next sync rebuilds content from the card files. Adding a structured filter column therefore bumps the version constant, and migration is the existing drop-and-rebuild — the FTS content is derived data, so no separate data migration exists. Card ids (`{type}-YYYYMMDD-{seq}`) are a stable contract and are never migrated.

**Team-repo migrations are a governed rollout, not an automatic rewrite.** Team cards are shared across checkouts; a breaking parser change must not ship before every checkout can read its output. The migration pass (a documented script that rewrites card files) is committed to the team repository in the same change that ships the parser change, and the change's rollout note states the order: migrate the repo, then upgrade the plugin. kb never rewrites a card file in place just because its parser changed.

## Alternatives considered

**A `schemaVersion` front-matter field with an upgrader chain.** Rejected: two authorities (the field and the parser) can disagree, hand-edited cards would need version maintenance, and the session-log upgrader pattern does not transfer — card files are user content, not a machine-owned log.

**Auto-rewriting cards that carry unknown keys.** Rejected: serialization without the unknown keys silently drops user data; failing loud keeps the write path honest and forces the parser change to ship with the field.

**Versioned directory layouts (e.g. `cards/v2/`).** Rejected: the card id is the identity across libraries and packs; a directory move would break every id reference and the promotion state machine for no migration benefit.

## Consequences

Every field addition ships as one change containing the parser, the schema bump if the index gains a column, and the docs; old cards stay readable and old indexes rebuild themselves on first open. A breaking field change is a coordinated rollout (migrate the team repo, then upgrade parsers) instead of a silent compatibility shim — the cost is coordination, the gain is that no parser ever silently misreads a card. The index's reset-in-place behavior is already tested for the version-mismatch path, so future schema bumps reuse a proven mechanism.
