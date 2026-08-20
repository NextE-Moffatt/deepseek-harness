/**
 * Public type vocabulary of the knowledge-base plugin: the card model, the
 * personal/team library split, the promotion lifecycle, and the `kb/*` session
 * events. Types only — no runtime code; the runtime sets live in `card.ts`.
 * @module @deepseek-ai/dsh-kb-core/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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
 * The three governance grades of the quality-grading mechanism (design §6):
 * `verified` is a ready/revived card inside its 有效期; `pending` is a card
 * awaiting verification; `verify` is a card that needs re-verification (a
 * ready/revived card past its 有效期, or a retired one). The grade is derived
 * from the card's status and expiry, never stored on the card.
 */
export type CardGrade = 'verified' | 'pending' | 'verify'

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
 * A knowledge pack: a subscribed card collection injected into agent sessions
 * at session start. The deployment's configured pack list IS the scenario
 * subscription — each pack carries the filters that select its cards.
 */
export interface KnowledgePack {
  /** Unique pack name, shown to the model as the pack header. */
  name: string
  /** Filter: every listed tag must be present on the card. */
  tags?: readonly string[]
  /** Filter: tier allowlist (personal-library tiers). */
  tier?: readonly CardTier[]
  /** Filter: library allowlist; when absent, cards from both libraries are eligible. */
  library?: readonly CardLibrary[]
  /** Filter: status allowlist; when absent, `archived` cards are excluded by default. */
  status?: readonly CardStatus[]
  /** Maximum cards injected per session; no cap when absent. */
  limit?: number
}

/** One injected card's rendered section, the replayable unit of a pack injection. */
export interface PackSection {
  /** The card id, also the rendered heading. */
  name: string
  /** The rendered card content (title / 适用条件 / 核心结论 / 应做 / 不应做 / optional 反例). */
  text: string
}

/** One recorded recap scan position: a session's event count at scan time. */
export interface RecapPosition {
  /** The scanned session. */
  sessionId: SessionId
  /** The session's event count when the position was recorded; positions only advance. */
  eventCount: number
}

/** One blind spot surfaced by a recap scan, without the derived excerpt. */
export interface RecapBlindSpot {
  /** The blind-spot session. */
  sessionId: SessionId
  /** The session's last event time (ISO), the recency sort key. */
  at: string
  /** The card ids the session consumed through `kb/injected`, sorted. */
  consumed: CardId[]
}

/**
 * The content fields an edit may change; absent fields keep their current
 * value. `反例` / `来源` accept an empty string to clear the field. The
 * identity (`id`), library (`库`), and lifecycle (`状态`) fields are not
 * editable — they stay with the file name, the dual gate, and the state
 * machine respectively.
 */
export interface CardEditPatch {
  /** Card type. */
  type?: CardType
  /** One-sentence title. */
  title?: string
  /** When to use this card. */
  适用条件?: string
  /** The conclusion in one paragraph. */
  核心结论?: string
  /** Executable positive actions; may become empty on edit. */
  应做?: string[]
  /** Executable negative actions; may become empty on edit. */
  不应做?: string[]
  /** Optional real counter-example; an empty string clears it. */
  反例?: string
  /** Objective evidence; an empty string clears it. */
  来源?: string
  /** Knowledge owner. */
  责任人?: string
  /** Expiry date `YYYY-MM-DD`. */
  有效期?: string
  /** Tags. */
  标签?: string[]
}

/**
 * The `kb/*` session events (model-visible state changes are logged, per the
 * model-visible ⟺ logged invariant). `kb/write` records a card write performed
 * by a tool; `kb/promote` records a lifecycle transition; `kb/edit` records a
 * content edit (the changed field names — the card file at its path stays the
 * content source of truth); `kb/injected` records one knowledge-pack
 * injection, carrying the full rendered content so the `kb:pack` prompt
 * section replays from the log alone; `kb/recap` records one recap scan's
 * checkpoint advancement (the listed blind spots and their recorded positions)
 * so the recap queue replays from the log alone; `kb/doc-write` and
 * `kb/doc-remove` record a human workbench write or removal of a team wiki
 * document (docs never enter the reference pool — the events are session
 * facts, like `kb/edit`). Tools append these after the underlying file
 * operation succeeds; the injection listener appends `kb/injected`
 * synchronously at `agent/session-start`.
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
    /** A card's content was edited (the workbench or a future edit consumer):
     * `fields` names the changed content fields; the card file at its path is
     * the content source of truth, exactly like `kb/write`. */
    'kb/edit': {
      id: CardId
      library: CardLibrary
      fields: string[]
    }
    /** A card's lifecycle state transitioned from `from` to `to` through the
     * promotion state machine; `evidence` carries the optional objective signal. */
    'kb/promote': { id: CardId; from: CardStatus; to: CardStatus; evidence?: string }
    /** One knowledge-pack injection at session start: the subscribed pack, the
     * card ids it selected (the telemetry face), and the rendered card sections
     * (the `kb:pack` prompt section's replayable source). */
    'kb/injected': {
      pack: string
      cardIds: CardId[]
      sections: PackSection[]
    }
    /** A personal card entered the team library through the first gate: the
     * card file now lives in the team repository at `path` with `status`
     * (always `pending`), and the promotion transition itself is the paired
     * `kb/promote` event. */
    'kb/team-join': {
      id: CardId
      path: string
      status: CardStatus
    }
    /** One recap scan recorded its checkpoint advancement: the positions
     * appended (`scanned`, the checkpoint's rebuild face) and the listed blind
     * spots (`blindSpots`, the surfaced queue's replayable facts; excerpts are
     * pure functions of each referenced session's own log). */
    'kb/recap': {
      scanDate: string
      scanned: RecapPosition[]
      blindSpots: RecapBlindSpot[]
      total: number
      listed: number
    }
    /** A team wiki document under `docs/` was written or overwritten through
     * the web workbench; the file at `path` stays the content source of
     * truth, exactly like `kb/write`. Docs never enter the reference pool. */
    'kb/doc-write': {
      path: string
      size: number
    }
    /** A team wiki document under `docs/` was removed through the web
     * workbench; the git work tree and the explicit `kb_team_commit` retain
     * the deleted file's history. */
    'kb/doc-remove': {
      path: string
    }
  }
}

/** One card's freshness position relative to today. */
export interface FreshnessPosition {
  /** Whether the card's 有效期 is before today. */
  overdue: boolean
  /** Whether the card expires within the warning window (not yet overdue). */
  expiringSoon: boolean
  /** Days from today to 有效期; negative when overdue. */
  daysLeft: number
}

/** The freshness recommendation for one card, feeding archive/revive/review. */
export type FreshnessRecommendation = 'renew' | 'review' | 'archive-candidate' | 'revive-candidate'

/** One entry of the pending-review list produced by the freshness scan. */
export interface ReviewEntry {
  /** Card id. */
  id: string
  /** Card title. */
  title: string
  /** Library the card lives in. */
  library: CardLibrary
  /** Lifecycle state. */
  status: CardStatus
  /** Quality grade derived from status and expiry. */
  grade: CardGrade
  /** Expiry date `YYYY-MM-DD`. */
  有效期: string
  /** Days from the scan date to 有效期; negative when overdue. */
  daysLeft: number
  /** Consumption count from the heat ledger. */
  heat: number
  /** The governance recommendation. */
  recommend: FreshnessRecommendation
}

/** The freshness scan outcome: the pending-review list split into overdue and expiring-soon. */
export interface FreshnessReview {
  /** Cards past their 有效期. */
  overdue: ReviewEntry[]
  /** Cards expiring within the warning window. */
  expiringSoon: ReviewEntry[]
  /** Total flagged cards. */
  total: number
}

/** One heat ledger entry: one card consumed by one session through one pack. */
export interface HeatEntry {
  /** The consumed card id. */
  cardId: CardId
  /** The consuming session id. */
  sessionId: SessionId
  /** ISO timestamp of the consumption event. */
  at: string
  /** The pack that injected the card. */
  pack: string
}

/** One aggregated heat row: a card's consumption across the ledger. */
export interface HeatRow {
  /** The consumed card id. */
  cardId: CardId
  /** Total consumption count. */
  count: number
  /** ISO timestamp of the most recent consumption. */
  lastAt: string
  /** The distinct consuming session ids, sorted. */
  sessions: string[]
  /** The distinct injecting packs, sorted. */
  packs: string[]
}
