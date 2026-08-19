/**
 * `ctx.kbWorkbench`: the web governance workbench host half — a Remote service
 * exposing one workspace's merged pending-review list (freshness + recap blind
 * spots), full card details, the flywheel metrics, and the lifecycle actions
 * (promote / archive / revive / review) that drive the existing `ctx.kb`
 * semantics and append the same `kb/*` events the tools append to the
 * workbench session's own log. The browser half is
 * `@deepseek-ai/dsh-client-ui-kb-workbench`.
 * @module @deepseek-ai/dsh-kb-web
 */

import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  detectBlindSpots, gradeCard, liveRecapLogSource, RecapCheckpoint, todayString,
} from '@deepseek-ai/dsh-kb-core'
import type {
  Card, CardId, CardStatus, FreshnessReview, HeatRow, RecapSessionLog,
} from '@deepseek-ai/dsh-kb-core'
import type {
  KbBlindSpotView, KbFlywheelMetrics, KbTopHeatEntry, KbWorkbenchCard, KbWorkbenchEditOptions, KbWorkbenchEditPatch, KbWorkbenchOverview,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The kb governance workbench service (see {@link KbWorkbenchService}). */
    kbWorkbench: KbWorkbenchService
  }
}

/** Deployment configuration of the kb workbench service. */
export interface KbWebConfig {
  /** Cap on the unrecorded blind spots the overview lists (default 20). */
  blindSpotLimit?: number
  /** How many top-heat cards the flywheel metrics carry (default 3). */
  topHeatCount?: number
}

/** The resolved kb workbench configuration, all fields concrete. */
export interface ResolvedKbWebConfig {
  /** Cap on the unrecorded blind spots the overview lists. */
  blindSpotLimit: number
  /** How many top-heat cards the flywheel metrics carry. */
  topHeatCount: number
}

/** Default cap on the overview's unrecorded blind-spot list. */
export const DEFAULT_BLIND_SPOT_LIMIT = 20
/** Default count of top-heat cards in the flywheel metrics. */
export const DEFAULT_TOP_HEAT_COUNT = 3

/** The promotion subset the workbench's promote action accepts (like `kb_promote`). */
const PROMOTION_TARGETS: readonly CardStatus[] = ['pending', 'ready']

/**
 * Resolve and validate the kb workbench configuration; invalid values fail
 * loud at load.
 * @param config - raw configuration.
 * @returns the resolved configuration with defaults applied.
 */
export function resolveConfig(config: KbWebConfig): ResolvedKbWebConfig {
  const blindSpotLimit = config.blindSpotLimit ?? DEFAULT_BLIND_SPOT_LIMIT
  const topHeatCount = config.topHeatCount ?? DEFAULT_TOP_HEAT_COUNT
  if (!Number.isSafeInteger(blindSpotLimit) || blindSpotLimit < 1) {
    throw new Error(`KbWebConfig.blindSpotLimit must be a positive integer, got ${JSON.stringify(blindSpotLimit)}`)
  }
  if (!Number.isSafeInteger(topHeatCount) || topHeatCount < 1) {
    throw new Error(`KbWebConfig.topHeatCount must be a positive integer, got ${JSON.stringify(topHeatCount)}`)
  }
  return { blindSpotLimit, topHeatCount }
}

/** The local date as `YYYY-MM-DD`, the overview's scan-date face. */
function scanDate(today?: string): string {
  return today ?? todayString()
}

/** The number of `kb/promote` transitions across the workspace's session logs. */
function countPromotions(logs: readonly RecapSessionLog[]): number {
  let count = 0
  for (const log of logs) {
    for (const event of log.events) {
      if (event.type === 'kb/promote') count += 1
    }
  }
  return count
}

/**
 * `ctx.kbWorkbench`: owns the web governance workbench seam — merged
 * pending-review views, card reads, flywheel metrics, and lifecycle actions
 * over `ctx.kb`. Every Remote method takes the session first; the workspace
 * root derives from `session.header.cwd`.
 */
export class KbWorkbenchService extends TypertRemoteService {
  static inject = ['kb']

  /** The resolved configuration. */
  readonly config: ResolvedKbWebConfig

  /**
   * @param ctx - registrant context carrying the kb service.
   * @param config - deployment configuration; defaults apply per field.
   */
  constructor(ctx: Context, config: KbWebConfig = {}) {
    super(ctx, 'kbWorkbench')
    this.config = resolveConfig(config)
  }

  /** The session's workspace root; fails loud when the session has none. */
  private requireRoot(session: Session): string {
    const root = session.header.cwd
    if (root === undefined) {
      throw new Error('kb workbench requires a session with a workspace (session cwd)')
    }
    return root
  }

  /**
   * The top-heat cards with their titles resolved, capped by config; a card
   * that no longer parses keeps its id as the title so the dashboard never
   * fails on a retired file.
   * @param root - the session workspace root.
   * @param rows - the aggregated heat ledger.
   * @returns the top rows, count descending.
   */
  private async topHeat(root: string, rows: readonly HeatRow[]): Promise<KbTopHeatEntry[]> {
    const top = [...rows].sort((a, b) => b.count - a.count || a.cardId.localeCompare(b.cardId))
      .slice(0, this.config.topHeatCount)
    return Promise.all(top.map(async (row): Promise<KbTopHeatEntry> => {
      let title: string = row.cardId
      try {
        title = (await this.ctx.kb.readCard(root, row.cardId)).card.title
      } catch {
        // The card file is gone or unparseable; the id remains the honest label.
      }
      return {
        cardId: row.cardId,
        title,
        count: row.count,
        lastSession: row.sessions[row.sessions.length - 1] ?? '',
      }
    }))
  }

  /**
   * The flywheel metrics, every number projected from `kb/*` events or their
   * persisted projections — never a second event stream.
   * @param root - the session workspace root.
   * @param logs - the workspace's session logs.
   * @param freshness - the freshness review.
   * @param heat - the aggregated heat ledger.
   * @param blindSpotCount - the unrecorded blind spots the overview lists.
   * @returns the metrics.
   */
  private async metrics(
    root: string,
    logs: readonly RecapSessionLog[],
    freshness: FreshnessReview,
    heat: readonly HeatRow[],
    blindSpotCount: number,
  ): Promise<KbFlywheelMetrics> {
    return {
      injections: heat.reduce((sum, row) => sum + row.count, 0),
      topHeat: await this.topHeat(root, heat),
      promotions: countPromotions(logs),
      pendingReview: freshness.total,
      blindSpots: blindSpotCount,
    }
  }

  /**
   * The merged pending-review view: freshness, the unrecorded recap blind
   * spots (detection without recording, so the checkpoint queue stays with
   * the tool and the scheduler), the heat ledger, and the flywheel metrics.
   * @param session - the workbench session (its cwd is the workspace root).
   * @param today - the reference date `YYYY-MM-DD` (defaults to today, local).
   * @returns the overview.
   */
  @Remote('overview')
  async overview(session: Session, today?: string): Promise<KbWorkbenchOverview> {
    const root = this.requireRoot(session)
    const kb = this.ctx.kb
    const [freshness, logs, recorded, heat] = await Promise.all([
      kb.freshnessReview(root, today),
      liveRecapLogSource(this.ctx).list(root),
      new RecapCheckpoint(resolve(root, kb.config.recapPath)).readAll(),
      kb.heat(root),
    ])
    const blindSpots: KbBlindSpotView[] = detectBlindSpots(logs, recorded)
      .slice(0, this.config.blindSpotLimit)
      .map(({ sessionId, at, consumed, excerpt }) => ({ sessionId, at, consumed, excerpt }))
    return {
      scanDate: scanDate(today),
      freshness,
      blindSpots,
      heat,
      metrics: await this.metrics(root, logs, freshness, heat, blindSpots.length),
    }
  }

  /**
   * Read one full card across the personal and team libraries.
   * @param session - the workbench session (its cwd is the workspace root).
   * @param id - the card id.
   * @returns the card view with its library, tier, path, derived grade, and
   * file identity (the edit conflict guard's expected values).
   * @throws when no library holds the id.
   */
  @Remote('card')
  async card(session: Session, id: string): Promise<KbWorkbenchCard> {
    const root = this.requireRoot(session)
    const kb = this.ctx.kb
    const cardId = id as CardId
    const personal = await kb.personalCard(root, cardId)
    if (personal !== undefined) {
      return {
        library: 'personal',
        card: personal.card,
        tier: personal.tier,
        path: personal.path,
        grade: gradeCard(personal.card, scanDate()),
        mtime: personal.mtime,
        size: personal.size,
      }
    }
    const team = await kb.teamCard(root, cardId)
    if (team !== undefined) {
      return {
        library: 'team',
        card: team.card,
        tier: 'team',
        path: team.path,
        grade: gradeCard(team.card, scanDate()),
        mtime: team.mtime,
        size: team.size,
      }
    }
    throw new Error(`card not found: ${id}`)
  }

  /**
   * The content-edit action: apply the patch through `KbService.editCard`
   * (conflict-guarded, team-gated) and append `kb/edit` to the workbench
   * session's log when the edit changed anything. The card file stays the
   * content source of truth, exactly like `kb_write`'s `kb/write` event.
   * @param session - the workbench session (its cwd is the workspace root).
   * @param id - the card id.
   * @param patch - the content-field patch.
   * @param options - the expected file identity and the team approval signal.
   * @returns the refreshed card view.
   */
  @Remote('edit')
  async edit(session: Session, id: string, patch: KbWorkbenchEditPatch, options?: KbWorkbenchEditOptions): Promise<KbWorkbenchCard> {
    const root = this.requireRoot(session)
    const result = await this.ctx.kb.editCard(root, id as CardId, patch, options)
    if (result.fields.length > 0) {
      session.append('kb/edit', { id: result.card.id, library: result.library, fields: result.fields })
    }
    return this.card(session, id)
  }

  /**
   * The promotion action: apply the transition and append `kb/promote` to the
   * workbench session's log, exactly like `kb_promote`.
   * @param session - the workbench session (its cwd is the workspace root).
   * @param id - the personal card id.
   * @param target - the promotion subset (`pending` or `ready`).
   * @param evidence - optional objective signal.
   * @returns the card in its new state plus the transition.
   */
  @Remote('promote')
  async promote(session: Session, id: string, target: CardStatus, evidence?: string): Promise<{
    card: Card
    from: CardStatus
    to: CardStatus
    path: string
    evidence?: string
  }> {
    if (!PROMOTION_TARGETS.includes(target)) {
      throw new Error(`kb workbench promote target must be one of ${PROMOTION_TARGETS.join(', ')}, got ${JSON.stringify(target)}`)
    }
    const root = this.requireRoot(session)
    const result = await this.ctx.kb.promote(root, id as CardId, target, evidence)
    session.append('kb/promote', {
      id: result.card.id,
      from: result.from,
      to: result.to,
      ...evidence === undefined ? {} : { evidence },
    })
    return result
  }

  /**
   * The archive action: retire a team card and append `kb/promote`, exactly
   * like `kb_archive`.
   * @param session - the workbench session (its cwd is the workspace root).
   * @param id - the team card id.
   * @returns the card in its new state, the previous state, and the file path.
   */
  @Remote('archive')
  async archive(session: Session, id: string): Promise<{ card: Card; from: CardStatus; path: string }> {
    const root = this.requireRoot(session)
    const result = await this.ctx.kb.archiveTeam(root, id as CardId)
    session.append('kb/promote', { id: result.card.id, from: result.from, to: 'archived' })
    return result
  }

  /**
   * The revive action: restore an archived team card and append `kb/promote`,
   * exactly like `kb_revive`.
   * @param session - the workbench session (its cwd is the workspace root).
   * @param id - the team card id.
   * @returns the card in its new state, the previous state, and the file path.
   */
  @Remote('revive')
  async revive(session: Session, id: string): Promise<{ card: Card; from: CardStatus; path: string }> {
    const root = this.requireRoot(session)
    const result = await this.ctx.kb.reviveTeam(root, id as CardId)
    session.append('kb/promote', { id: result.card.id, from: result.from, to: 'revived' })
    return result
  }

  /**
   * The second-gate action: an approved review transitions a team `pending`
   * card to `ready` and appends `kb/promote`; a rejected review changes
   * nothing and appends nothing, exactly like `kb_review`.
   * @param session - the workbench session (its cwd is the workspace root).
   * @param id - the team card id.
   * @param approved - whether the reviewer approved the card.
   * @returns the card and whether the state changed.
   */
  @Remote('review')
  async review(session: Session, id: string, approved: boolean): Promise<{ card: Card; changed: boolean }> {
    const root = this.requireRoot(session)
    const reviewed = await this.ctx.kb.reviewTeam(root, id as CardId, approved)
    if (reviewed.changed) {
      session.append('kb/promote', { id: reviewed.card.id, from: 'pending', to: 'ready' })
    }
    return reviewed
  }
}

export default KbWorkbenchService
