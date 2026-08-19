/**
 * kb-govern freshness: the scan orchestration and the `ctx.jobs` scheduler.
 * The scan reads the personal and team libraries plus the workspace heat
 * ledger, derives the review recommendation per card, and renders the
 * pending-review list. The scheduler is a per-session owner-scoped job started
 * at `agent/session-start` when `KbConfig.freshnessIntervalDays` is positive;
 * the job runs one scan immediately and then every interval, buffering the
 * rendered list as its output. The on-demand `kb_freshness` tool drives the
 * same scan, so the review list is reconstructable from the session log
 * whenever a model sees it.
 * @module @deepseek-ai/dsh-kb-core/freshness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { resolve } from 'node:path'
import {
  partitionReview, renderReviewList, toReviewEntry,
  type FreshnessReview, type ReviewEntry,
} from './govern.ts'
import { PersonalCardStore } from './store.ts'
import { TeamCardStore } from './team.ts'
import { aggregateHeat, HeatLedger } from './telemetry.ts'
import { todayString } from './date.ts'
import type { KbService } from './index.ts'

/** One day in milliseconds; the scheduler ticks daily and counts down days. */
const DAY_MS = 86_400_000

/**
 * Run the freshness scan for one workspace: every card of both libraries gets
 * a review entry with its heat and recommendation, partitioned into overdue
 * and expiring-soon. A missing or unparseable team repository logs and
 * continues with the personal side — the scan must never fail the request
 * that asked for it.
 * @param ctx - registrant context, for diagnostics.
 * @param kb - the kb service holding the config.
 * @param root - the session workspace root.
 * @param today - the reference date `YYYY-MM-DD` (defaults to today, local).
 * @returns the pending-review list.
 */
export async function freshnessReview(ctx: Context, kb: KbService, root: string, today: string = todayString()): Promise<FreshnessReview> {
  const heat = new Map<string, number>()
  for (const row of aggregateHeat(await new HeatLedger(resolve(root, kb.config.heatPath)).readAll())) {
    heat.set(row.cardId, row.count)
  }
  const entries: ReviewEntry[] = []
  const personal = new PersonalCardStore(resolve(root), kb.config.cardsPath)
  const personalListed = await personal.list()
  for (const failure of personalListed.failures) {
    ctx.logger.debug('dsh-kb-core: ignoring unparseable personal card file %s: %s', failure.path, failure.message)
  }
  for (const info of personalListed.cards) {
    entries.push(toReviewEntry(info.card, 'personal', heat.get(info.card.id) ?? 0, today, kb.config.freshnessWarningDays))
  }
  if (kb.config.teamRepoPath !== undefined) {
    try {
      const team = new TeamCardStore(kb.teamRepoRoot(root))
      const teamListed = await team.list()
      for (const failure of teamListed.failures) {
        ctx.logger.debug('dsh-kb-core: ignoring unparseable team card file %s: %s', failure.path, failure.message)
      }
      for (const info of teamListed.cards) {
        entries.push(toReviewEntry(info.card, 'team', heat.get(info.card.id) ?? 0, today, kb.config.freshnessWarningDays))
      }
    } catch (error) {
      ctx.logger.warn('dsh-kb-core: team library unavailable for freshness scan, continuing with the personal library: %o', error)
    }
  }
  return partitionReview(entries, kb.config.freshnessWarningDays)
}

/**
 * The rendered freshness review for one workspace — the scheduler's output
 * unit and the `kb_freshness` tool's text face.
 * @param ctx - registrant context, for diagnostics.
 * @param kb - the kb service.
 * @param root - the session workspace root.
 * @returns the rendered pending-review list (possibly empty).
 */
export async function freshnessReviewText(ctx: Context, kb: KbService, root: string): Promise<string> {
  const review = await freshnessReview(ctx, kb, root)
  return renderReviewList(review, todayString())
}

/**
 * Create the freshness job's producer hooks: one immediate scan, then a scan
 * every `intervalDays` (a daily timer counting down days, because interval
 * lengths beyond ~24.8 days exceed Node's clamped timer delay). The rendered
 * list accumulates as stream output until read; `cancel` stops the timer and
 * settles the job as killed.
 * @param scan - the scan producing the rendered review list.
 * @param intervalDays - the scan interval in whole days (positive).
 * @returns the job hooks for `JobStart.run()`.
 */
export function createFreshnessProducer(scan: () => Promise<string>, intervalDays: number): JobHooks {
  let timer: NodeJS.Timeout | undefined
  let pending = ''
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolveDone) => { settle = resolveDone })
  const tick = (): void => {
    scan().then((text) => {
      if (text !== '') pending += `${text}\n`
    }).catch(() => {
      // The scan logs its own failures; a failed tick must not stop the schedule.
    })
  }
  const cancel = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    settle({ status: 'killed' })
  }
  let remaining = intervalDays
  tick()
  timer = setInterval(() => {
    remaining -= 1
    if (remaining <= 0) {
      remaining = intervalDays
      tick()
    }
  }, DAY_MS)
  return {
    cancel,
    done,
    readOutput: () => {
      const output = pending
      pending = ''
      return output
    },
  }
}

/** Contexts that already logged the "scheduling unavailable" error. */
const warnedContexts = new WeakSet<object>()

/** Sessions that already own a freshness job; jobs are per-session, like injection. */
const scheduledSessions = new WeakSet<object>()

/**
 * Register the freshness scheduler: at `agent/session-start`, start one
 * owner-scoped `kb-freshness` job per session (the log-free guard is a
 * per-session object set) when the interval is configured. A configured
 * interval without a jobs service logs one loud error per context and skips
 * scheduling — the earliest resolvable point, never silent.
 * @param ctx - registrant context carrying the agent bus and jobs service.
 * @param kb - the kb service holding the freshness config.
 */
export function registerFreshnessSchedule(ctx: Context, kb: KbService): void {
  ctx.on('agent/session-start', ({ agent }) => {
    if (kb.config.freshnessIntervalDays <= 0) return
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      if (!warnedContexts.has(ctx)) {
        warnedContexts.add(ctx)
        ctx.logger.error('dsh-kb-core: freshnessIntervalDays is configured but no jobs service is mounted; freshness scheduling is unavailable (mount @deepseek-ai/dsh-jobs-local)')
      }
      return
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    if (scheduledSessions.has(agent.session)) return
    scheduledSessions.add(agent.session)
    jobs.start({
      kind: 'kb-freshness',
      label: `知识保鲜扫描（每 ${kb.config.freshnessIntervalDays} 天）`,
      owner: agent,
      run: () => createFreshnessProducer(
        () => freshnessReviewText(ctx, kb, cwd),
        kb.config.freshnessIntervalDays,
      ),
    })
  })
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'kb-freshness': 'kb-freshness'
  }
}
