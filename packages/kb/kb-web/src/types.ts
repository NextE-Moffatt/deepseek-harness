/**
 * Pure wire types of the kb governance workbench: the overview payload, the
 * flywheel metrics, the card view, and the action results — free of this
 * package's host-side imports (cordis, the service). Two namespace projections
 * serve it: `./types` for host consumers and `./client` (the browser half's
 * re-export) for client aggregates, with zero content duplication.
 *
 * @module @deepseek-ai/dsh-kb-web/types
 */

import type { Card, CardEditPatch, CardId, CardGrade, CardLibrary, FreshnessReview, HeatRow } from '@deepseek-ai/dsh-kb-core/types'

/** One top-heat card entry with its resolved title. */
export interface KbTopHeatEntry {
  /** The card id. */
  readonly cardId: CardId
  /** The card title. */
  readonly title: string
  /** The consumption count (sessions that injected the card). */
  readonly count: number
  /** The most recent consuming session id. */
  readonly lastSession: string
}

/** One unrecorded recap blind spot listed by the workbench (read-only detection). */
export interface KbBlindSpotView {
  /** The blind-spot session id. */
  readonly sessionId: string
  /** The session's last event time (ISO). */
  readonly at: string
  /** The card ids the session consumed, sorted. */
  readonly consumed: readonly CardId[]
  /** The bounded conversation excerpt, the distillation material. */
  readonly excerpt: string
}

/**
 * The flywheel start-up metrics, every number projected from `kb/*` events or
 * their persisted projections (heat ledger, recap checkpoint, card files).
 */
export interface KbFlywheelMetrics {
  /** Total knowledge injections (the heat-ledger count sum). */
  readonly injections: number
  /** The top-heat cards by consumption count. */
  readonly topHeat: readonly KbTopHeatEntry[]
  /** Total promotion transitions across the workspace's session logs. */
  readonly promotions: number
  /** The pending review count: freshness overdue + expiring-soon cards. */
  readonly pendingReview: number
  /** The unrecorded recap blind spots. */
  readonly blindSpots: number
}

/** The workbench's merged pending-review view plus the flywheel metrics. */
export interface KbWorkbenchOverview {
  /** The scan date `YYYY-MM-DD`. */
  readonly scanDate: string
  /** The freshness pending-review list. */
  readonly freshness: FreshnessReview
  /** The unrecorded recap blind spots, most recent first, capped by config. */
  readonly blindSpots: readonly KbBlindSpotView[]
  /** The workspace's aggregated heat ledger. */
  readonly heat: readonly HeatRow[]
  /** The flywheel metrics. */
  readonly metrics: KbFlywheelMetrics
}

/** One full card as the workbench renders it. */
export interface KbWorkbenchCard {
  /** The library the card lives in. */
  readonly library: CardLibrary
  /** The parsed card. */
  readonly card: Card
  /** The tier directory for personal cards, or `team` for team cards. */
  readonly tier: string
  /** The absolute card file path. */
  readonly path: string
  /** The derived quality grade. */
  readonly grade: CardGrade
  /** File mtime in epoch milliseconds, the edit conflict guard's expected identity. */
  readonly mtime: number
  /** File size in bytes, the edit conflict guard's expected identity. */
  readonly size: number
}

/** The content-field patch the workbench edit sends (see `CardEditPatch`). */
export type KbWorkbenchEditPatch = CardEditPatch

/** The edit request options: the optimistic identity and the team approval signal. */
export interface KbWorkbenchEditOptions {
  /** Expected on-disk identity observed at detail load; a mismatch fails the edit. */
  readonly expected?: { mtime: number; size: number }
  /** Explicit approval for a team-card edit under `KbConfig.teamWriteApproval`. */
  readonly approved?: boolean
}
