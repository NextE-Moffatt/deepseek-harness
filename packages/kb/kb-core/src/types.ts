/**
 * Public type vocabulary of the knowledge-base plugin: the card model, the
 * personal/team library split, the promotion lifecycle, and the `kb/*` session
 * events. Types only — no runtime code; the runtime sets live in `card.ts`.
 * @module @deepseek-ai/dsh-kb-core/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * A knowledge-card id, unique across one library. The design's id format is
 * `{type}-YYYYMMDD-{seq}` (for example `rule-20250818-001`); the format is
 * enforced by the card parser, not by this brand.
 */
export type CardId = Branded<'CardId'>

/** The four knowledge-card types of the shared card spec (§4.1). */
export type CardType = 'rule' | 'case' | 'howto' | 'decision'

/** Which library a card belongs to. Milestone 1 ships `personal`; `team` is the shared git repo (post-milestone-1). */
export type CardLibrary = 'personal' | 'team'

/**
 * Lifecycle states of the promotion pipeline. `draft` is the personal-library
 * entry state; `pending` awaits verification; `ready` is the reference pool;
 * `archived` is retired; `revived` is a restored-active state, distinct from
 * never-archived `ready` so governance can tell the two apart.
 */
export type CardStatus = 'draft' | 'pending' | 'ready' | 'archived' | 'revived'

/** Personal-library tiers, encoded as the card's directory: P0 Inbox, P1 project notes, P2 draft cards, P3 private experience. */
export type CardTier = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * A knowledge card: Markdown body plus YAML front matter, one spec for both
 * libraries (§4.1/§4.2). Front-matter keys 库/状态/适用条件/来源/责任人/有效期/标签
 * are the fixed user-facing data format and mirror verbatim as property names;
 * the body sections 核心结论/应做/不应做/反例 / 踩坑记录 parse into the remaining
 * fields.
 */
export interface Card {
  /** Unique id, format `{type}-YYYYMMDD-{seq}`. */
  id: CardId
  /** Card type: rule / case / howto / decision. */
  type: CardType
  /** One sentence naming what knowledge this card solves. */
  title: string
  /** Library: personal or team. */
  库: CardLibrary
  /** Lifecycle state. */
  状态: CardStatus
  /** When to use this card — the retrieval-hit key. */
  适用条件: string
  /** The conclusion in one paragraph. */
  核心结论: string
  /** Executable positive actions. May be empty for imported cards; `kb_write` requires at least one. */
  应做: string[]
  /** Executable negative actions. May be empty for imported cards; `kb_write` requires at least one. */
  不应做: string[]
  /** Optional real counter-example / pitfall record. */
  反例?: string
  /** Objective evidence (MR, incident id, document link). Optional for personal drafts. */
  来源?: string
  /** Knowledge owner: the person for personal cards, the knowledge owner for team cards. */
  责任人: string
  /** Expiry date `YYYY-MM-DD`; overdue cards need re-verification. */
  有效期: string
  /** Tags / scenes used by knowledge-pack subscriptions and filtering. */
  标签: string[]
}

/**
 * The `kb/*` session events (model-visible state changes are logged, per the
 * model-visible ⟺ logged invariant). `kb/write` records a card write performed
 * by a tool; `kb/promote` records a lifecycle transition. Tools append these
 * after the underlying file operation succeeds.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A card file was written by `kb_write` (or re-imported with a session
     * attached); the card is reconstructable from the file at `path`. */
    'kb/write': {
      id: CardId
      library: CardLibrary
      tier: CardTier
      status: CardStatus
      title: string
      path: string
    }
    /** A card's lifecycle state transitioned from `from` to `to` through the
     * promotion state machine; `evidence` carries the optional objective signal. */
    'kb/promote': { id: CardId; from: CardStatus; to: CardStatus; evidence?: string }
  }
}
