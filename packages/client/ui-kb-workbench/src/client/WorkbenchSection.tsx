/**
 * The knowledge-base governance workbench section: flywheel metrics, the
 * merged pending-review list (freshness + recap blind spots), the card detail,
 * and the lifecycle actions. All data arrives through the inject face (the
 * `kbWorkbench` Remote namespace); the component holds no service access and
 * no second event stream — every number is the host's projection of `kb/*`
 * events or their persisted files.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CardStatus } from '@deepseek-ai/dsh-kb-core/types'
import type {
  KbBlindSpotView, KbWorkbenchCard, KbWorkbenchOverview,
} from '@deepseek-ai/dsh-kb-web/client'
import type { KbWorkbenchKey } from './locales.ts'
import styles from './WorkbenchSection.module.css'

/** The inject face the settings outlet spreads into the section props. */
export interface WorkbenchSectionInjected {
  /** Bound section copy. */
  t: (key: KbWorkbenchKey) => string
  /** The merged pending-review view plus the flywheel metrics. */
  overview: (sessionId: SessionId, today?: string) => Promise<RemoteResult<KbWorkbenchOverview>>
  /** One full card. */
  card: (sessionId: SessionId, id: string) => Promise<RemoteResult<KbWorkbenchCard>>
  /** The promotion transition (draft → pending, pending → ready). */
  promote: (sessionId: SessionId, id: string, target: CardStatus, evidence?: string) => Promise<RemoteResult<unknown>>
  /** The retire edge (ready/revived → archived). */
  archive: (sessionId: SessionId, id: string) => Promise<RemoteResult<unknown>>
  /** The restore edge (archived → revived). */
  revive: (sessionId: SessionId, id: string) => Promise<RemoteResult<unknown>>
  /** The second gate (pending → ready on approval). */
  review: (sessionId: SessionId, id: string, approved: boolean) => Promise<RemoteResult<unknown>>
}

/** Props delivered by the settings outlet: runtime seat plus the inject face. */
export type WorkbenchSectionProps = GlobalStandardProps & Partial<WorkbenchSectionInjected>

/** A session that can serve the workbench: it has a workspace root. */
interface WorkspaceCandidate {
  sessionId: SessionId
  cwd: string
}

/** The pending review rows the workbench renders (freshness entries + blind spots). */
type ReviewRow =
  | { kind: 'overdue'; id: string; title: string; library: string; daysLeft: number }
  | { kind: 'expiring'; id: string; title: string; library: string; daysLeft: number }
  | { kind: 'blindSpot'; view: KbBlindSpotView }

/** Whether the given card supports the given lifecycle action. */
function actionOf(card: KbWorkbenchCard): 'promote-pending' | 'promote-ready' | 'review' | 'archive' | 'revive' | undefined {
  if (card.library === 'personal') {
    if (card.card.状态 === 'draft') return 'promote-pending'
    if (card.card.状态 === 'pending') return 'promote-ready'
    return undefined
  }
  if (card.card.状态 === 'pending') return 'review'
  if (card.card.状态 === 'archived') return 'revive'
  if (card.card.状态 === 'ready' || card.card.状态 === 'revived') return 'archive'
  return undefined
}

/** The flywheel metric tile labels (the top-heat list renders separately). */
type KbNumberMetric = 'injections' | 'promotions' | 'pendingReview' | 'blindSpots'
const METRICS: readonly (readonly [KbWorkbenchKey, KbNumberMetric])[] = [
  ['metrics.injections', 'injections'],
  ['metrics.promotions', 'promotions'],
  ['metrics.pendingReview', 'pendingReview'],
  ['metrics.blindSpots', 'blindSpots'],
]

/**
 * The governance workbench section body.
 * @param props - the outlet's runtime seat plus the injected remote face.
 * @returns the section content.
 */
export function WorkbenchSection(props: WorkbenchSectionProps): ReactNode {
  const { useSessions, t = () => '', overview, card, promote, archive, revive, review } = props
  const sessions = useSessions(s => s)

  // The workspace candidates: sessions whose cwd can serve the workbench.
  const candidates = useMemo<WorkspaceCandidate[]>(() => {
    const seen = new Map<string, WorkspaceCandidate>()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary?.cwd === undefined) continue
      const existing = seen.get(summary.cwd)
      if (existing === undefined || summary.updatedAt > (sessions.byId[existing.sessionId]?.updatedAt ?? 0)) {
        seen.set(summary.cwd, { sessionId: id, cwd: summary.cwd })
      }
    }
    return [...seen.values()]
  }, [sessions])

  const [sessionId, setSessionId] = useState<SessionId | undefined>(undefined)
  const [overviewData, setOverviewData] = useState<KbWorkbenchOverview | undefined>(undefined)
  const [detail, setDetail] = useState<KbWorkbenchCard | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const activeSessionId = sessionId ?? sessions.current ?? candidates[0]?.sessionId

  const loadOverview = useCallback(async (target: SessionId | undefined): Promise<void> => {
    if (target === undefined || overview === undefined) return
    setError(undefined)
    const result = await overview(target)
    if (result.ok) {
      setOverviewData(result.value)
      setSessionId(target)
    } else {
      setError(result.error.message)
    }
  }, [overview])

  useEffect(() => {
    void loadOverview(activeSessionId)
  }, [loadOverview, activeSessionId])

  const openCard = useCallback(async (id: string): Promise<void> => {
    if (activeSessionId === undefined || card === undefined) return
    const result = await card(activeSessionId, id)
    setDetail(result.ok ? result.value : undefined)
    if (!result.ok) setError(result.error.message)
  }, [activeSessionId, card])

  const runAction = useCallback(async (run: () => Promise<RemoteResult<unknown>>): Promise<void> => {
    // The disabled buttons block clicks while busy; the guard only catches a
    // same-frame double invocation before the re-render lands.
    /* v8 ignore next -- unreachable through the UI: disabled buttons swallow clicks */
    if (busy) return
    setBusy(true)
    setError(undefined)
    const result = await run()
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    // Refresh the merged view and the open detail after every mutation.
    await loadOverview(activeSessionId)
    // v8 ignore next -- actions only render from an open detail, so one is always set here
    if (detail !== undefined) await openCard(detail.card.id)
  }, [busy, activeSessionId, detail, loadOverview, openCard])

  /**
   * The action buttons render only after the overview resolved, so the session
   * and the detail are present; a missing injected face is a broken
   * composition that fails loud at the click instead of rendering a dead button.
   */
  const actionSession = activeSessionId as SessionId
  const runPromote = (target: CardStatus): void => {
    if (detail === undefined || promote === undefined) throw new Error('kb workbench: promote face is missing')
    void runAction(() => promote(actionSession, detail.card.id, target))
  }
  const runReview = (approved: boolean): void => {
    if (detail === undefined || review === undefined) throw new Error('kb workbench: review face is missing')
    void runAction(() => review(actionSession, detail.card.id, approved))
  }
  const runArchive = (): void => {
    if (detail === undefined || archive === undefined) throw new Error('kb workbench: archive face is missing')
    void runAction(() => archive(actionSession, detail.card.id))
  }
  const runRevive = (): void => {
    if (detail === undefined || revive === undefined) throw new Error('kb workbench: revive face is missing')
    void runAction(() => revive(actionSession, detail.card.id))
  }

  const rows = useMemo<ReviewRow[]>(() => {
    if (overviewData === undefined) return []
    const freshness: ReviewRow[] = [
      ...overviewData.freshness.overdue.map(entry => ({
        kind: 'overdue' as const, id: entry.id, title: entry.title,
        library: entry.library, daysLeft: entry.daysLeft,
      })),
      ...overviewData.freshness.expiringSoon.map(entry => ({
        kind: 'expiring' as const, id: entry.id, title: entry.title,
        library: entry.library, daysLeft: entry.daysLeft,
      })),
    ]
    return [...freshness, ...overviewData.blindSpots.map(view => ({ kind: 'blindSpot' as const, view }))]
  }, [overviewData])

  if (candidates.length === 0) {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('error.title')}</h2>
        <p className={styles.hint}>{t('error.hint')}</p>
      </section>
    )
  }

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <label className={styles.workspaceLabel} htmlFor="kb-workbench-workspace">
          {t('workspace.label')}
        </label>
        <select
          id="kb-workbench-workspace"
          className={styles.workspaceSelect}
          // v8 ignore next -- the select only renders when candidates are non-empty, so this fallback is unreachable
          value={activeSessionId ?? ''}
          onChange={(event) => { void loadOverview(event.target.value as SessionId) }}
        >
          {candidates.map(candidate => (
            <option key={candidate.sessionId} value={candidate.sessionId}>{candidate.cwd}</option>
          ))}
        </select>
      </div>

      {error !== undefined && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.retry} onClick={() => { void loadOverview(activeSessionId) }}>
            {t('error.reload')}
          </button>
        </div>
      )}

      {overviewData === undefined && error === undefined && <p className={styles.hint}>{t('action.busy')}</p>}

      {overviewData !== undefined && (
        <>
          <h2 className={styles.sectionTitle}>{t('metrics.title')}</h2>
          <ul className={styles.metrics}>
            {METRICS.map(([key, field]) => (
              <li key={key} className={styles.metricTile}>
                <span className={styles.metricLabel}>{t(key)}</span>
                <span className={styles.metricValue}>{overviewData.metrics[field]}</span>
              </li>
            ))}
          </ul>
          <div className={styles.topHeat}>
            <span className={styles.metricLabel}>{t('metrics.topHeat')}</span>
            {overviewData.metrics.topHeat.length === 0
              ? <span className={styles.metricValue}>{t('metrics.empty')}</span>
              : (
                <ol className={styles.topHeatList}>
                  {overviewData.metrics.topHeat.map(entry => (
                    <li key={entry.cardId}>
                      <button type="button" className={styles.cardLink} onClick={() => { void openCard(entry.cardId) }}>
                        {entry.title}
                      </button>
                      <span className={styles.topHeatCount}>{entry.count}</span>
                    </li>
                  ))}
                </ol>
              )}
          </div>

          <h2 className={styles.sectionTitle}>{t('list.title')}</h2>
          {rows.length === 0 && <p className={styles.hint}>{t('list.empty')}</p>}
          <ul className={styles.reviewList}>
            {rows.map((row, index) => {
              if (row.kind === 'blindSpot') {
                return (
                  <li key={`blind-${index}`} className={styles.reviewRow}>
                    <div className={styles.reviewRowTitle}>
                      <span className={styles.reviewBadge}>{t('list.blindSpot')}</span>
                      <span className={styles.reviewRowId}>{row.view.sessionId}</span>
                    </div>
                    <p className={styles.reviewRowBody}>{row.view.excerpt}</p>
                    <div className={styles.reviewRowMeta}>
                      {row.view.consumed.length > 0 && (
                        <span className={styles.reviewRowConsumed}>
                          {t('list.blindSpotConsumed').replace('{cards}', row.view.consumed.join('、'))}
                        </span>
                      )}
                      {row.view.consumed.map(id => (
                        <button key={id} type="button" className={styles.cardLink} onClick={() => { void openCard(id) }}>
                          {id}
                        </button>
                      ))}
                    </div>
                  </li>
                )
              }
              const badge = row.kind === 'overdue' ? t('list.overdue') : t('list.expiringSoon')
              return (
                <li key={`${row.kind}-${row.id}`} className={styles.reviewRow}>
                  <div className={styles.reviewRowTitle}>
                    <span className={styles.reviewBadge}>{badge}</span>
                    <button type="button" className={styles.cardLink} onClick={() => { void openCard(row.id) }}>
                      {row.title}
                    </button>
                    <span className={styles.reviewRowId}>{row.id}</span>
                  </div>
                  <div className={styles.reviewRowMeta}>
                    <span>{row.library}</span>
                    <span>{row.kind === 'overdue' ? -row.daysLeft : row.daysLeft} 天</span>
                  </div>
                </li>
              )
            })}
          </ul>

          {detail !== undefined && (
            <div className={styles.detail}>
              <h2 className={styles.sectionTitle}>
                {t('card.title')}：{detail.card.title}
              </h2>
              <dl className={styles.cardFields}>
                <dt>{t('card.id')}</dt><dd>{detail.card.id}</dd>
                <dt>{t('card.library')}</dt><dd>{detail.library}</dd>
                <dt>{t('card.tier')}</dt><dd>{detail.tier}</dd>
                <dt>{t('card.status')}</dt><dd>{detail.card.状态}</dd>
                <dt>{t('card.grade')}</dt>
                <dd>{detail.grade === 'verified' ? t('grade.verified') : detail.grade === 'pending' ? t('grade.pending') : t('grade.verify')}</dd>
                <dt>{t('card.expiry')}</dt><dd>{detail.card.有效期}</dd>
                <dt>{t('card.owner')}</dt><dd>{detail.card.责任人}</dd>
                <dt>{t('card.tags')}</dt><dd>{detail.card.标签.join('、')}</dd>
                {detail.card.来源 !== undefined && <><dt>{t('card.source')}</dt><dd>{detail.card.来源}</dd></>}
                <dt>{t('card.condition')}</dt><dd>{detail.card.适用条件}</dd>
                <dt>{t('card.conclusion')}</dt><dd>{detail.card.核心结论}</dd>
                <dt>{t('card.do')}</dt><dd>{detail.card.应做.join('；')}</dd>
                <dt>{t('card.dont')}</dt><dd>{detail.card.不应做.join('；')}</dd>
                {detail.card.反例 !== undefined && <><dt>{t('card.counterExample')}</dt><dd>{detail.card.反例}</dd></>}
              </dl>
              <div className={styles.actions}>
                {actionOf(detail) === 'promote-pending' && (
                  <button type="button" className={styles.action} disabled={busy}
                    onClick={() => { runPromote('pending') }}>
                    {busy ? t('action.busy') : t('action.promotePending')}
                  </button>
                )}
                {actionOf(detail) === 'promote-ready' && (
                  <button type="button" className={styles.action} disabled={busy}
                    onClick={() => { runPromote('ready') }}>
                    {busy ? t('action.busy') : t('action.promoteReady')}
                  </button>
                )}
                {actionOf(detail) === 'review' && (
                  <>
                    <button type="button" className={styles.action} disabled={busy}
                      onClick={() => { runReview(true) }}>
                      {busy ? t('action.busy') : t('action.reviewApprove')}
                    </button>
                    <button type="button" className={styles.action} disabled={busy}
                      onClick={() => { runReview(false) }}>
                      {busy ? t('action.busy') : t('action.reviewReject')}
                    </button>
                  </>
                )}
                {actionOf(detail) === 'archive' && (
                  <button type="button" className={styles.action} disabled={busy}
                    onClick={() => { runArchive() }}>
                    {busy ? t('action.busy') : t('action.archive')}
                  </button>
                )}
                {actionOf(detail) === 'revive' && (
                  <button type="button" className={styles.action} disabled={busy}
                    onClick={() => { runRevive() }}>
                    {busy ? t('action.busy') : t('action.revive')}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
