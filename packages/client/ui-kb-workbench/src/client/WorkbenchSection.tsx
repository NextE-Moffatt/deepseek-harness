/**
 * The knowledge-base governance workbench section: flywheel metrics, the
 * merged pending-review list (freshness + recap blind spots), the team wiki
 * docs block (list / read / edit / remove), the card detail with its
 * lifecycle actions and content edit form, and the team-edit confirmation.
 * All data arrives through the inject face (the `kbWorkbench` Remote
 * namespace); the component holds no service access and no second event
 * stream — every number is the host's projection of `kb/*` events or their
 * persisted files, and every edit is a `kb/edit` or `kb/doc-*` session fact
 * on the host side.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CardStatus, CardType } from '@deepseek-ai/dsh-kb-core/types'
import type {
  KbBlindSpotView, KbWorkbenchCard,
  KbWorkbenchEditOptions, KbWorkbenchEditPatch, KbWorkbenchOverview,
} from '@deepseek-ai/dsh-kb-web/client'
import type { KbWorkbenchKey } from './locales.ts'
import { TeamDocs, type TeamDocsInjected } from './TeamDocs.tsx'
import styles from './WorkbenchSection.module.css'

/** The four card types, the edit form's closed option set. */
const CARD_TYPE_OPTIONS = ['rule', 'case', 'howto', 'decision'] as const

/** The inject face the settings outlet spreads into the section props. */
export type WorkbenchSectionInjected = {
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
  /** The content edit (conflict-guarded on the host; team edits need approval). */
  edit: (
    sessionId: SessionId,
    id: string,
    patch: KbWorkbenchEditPatch,
    options?: KbWorkbenchEditOptions,
  ) => Promise<RemoteResult<KbWorkbenchCard>>
} & Pick<TeamDocsInjected, 'listDocs' | 'readDoc' | 'writeDoc' | 'removeDoc'>

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

/** The edit form's field values; list fields are text (one item per line), tags are `、`-separated. */
interface EditFormValues {
  type: CardType
  title: string
  适用条件: string
  核心结论: string
  应做: string
  不应做: string
  反例: string
  来源: string
  责任人: string
  有效期: string
  标签: string
}

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

/** Seed the edit form from a card's current fields. */
function formFromCard(card: KbWorkbenchCard['card']): EditFormValues {
  return {
    type: card.type,
    title: card.title,
    适用条件: card.适用条件,
    核心结论: card.核心结论,
    应做: card.应做.join('\n'),
    不应做: card.不应做.join('\n'),
    反例: card.反例 ?? '',
    来源: card.来源 ?? '',
    责任人: card.责任人,
    有效期: card.有效期,
    标签: card.标签.join('、'),
  }
}

/** Split a list field's text on newlines or `、` into trimmed non-empty items. */
function splitList(text: string): string[] {
  return text.split(/\r?\n|、/).map(item => item.trim()).filter(item => item !== '')
}

/** Build the edit patch from the form; an empty optional field clears it. */
function patchFromForm(form: EditFormValues): KbWorkbenchEditPatch {
  return {
    type: form.type,
    title: form.title.trim(),
    适用条件: form.适用条件.trim(),
    核心结论: form.核心结论.trim(),
    应做: splitList(form.应做),
    不应做: splitList(form.不应做),
    反例: form.反例.trim(),
    来源: form.来源.trim(),
    责任人: form.责任人.trim(),
    有效期: form.有效期.trim(),
    标签: splitList(form.标签),
  }
}

/**
 * The governance workbench section body.
 * @param props - the outlet's runtime seat plus the injected remote face.
 * @returns the section content.
 */
export function WorkbenchSection(props: WorkbenchSectionProps): ReactNode {
  const {
    useSessions, t = () => '', overview, card, promote, archive, revive, review, edit,
    listDocs, readDoc, writeDoc, removeDoc,
  } = props
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
  // The edit form state: active card identity, the expected file identity for
  // the conflict guard, the field values, and the team-edit confirmation.
  const [editing, setEditing] = useState(false)
  const [editId, setEditId] = useState<string | undefined>(undefined)
  const [expected, setExpected] = useState<{ mtime: number; size: number } | undefined>(undefined)
  const [form, setForm] = useState<EditFormValues | undefined>(undefined)
  const [approved, setApproved] = useState(false)

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
    setEditing(false)
    setError(undefined)
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

  const runSave = useCallback(async (): Promise<void> => {
    /* v8 ignore next -- the form only renders with the detail, the form, and the session present; runEdit guards the missing edit face */
    if (detail === undefined || edit === undefined || form === undefined || activeSessionId === undefined) return
    /* v8 ignore next -- the submit button is disabled while busy */
    if (busy) return
    setBusy(true)
    setError(undefined)
    const patch = patchFromForm(form)
    const options: KbWorkbenchEditOptions = {
      /* v8 ignore next -- beginEdit always captures the detail identity before the form renders */
      ...expected === undefined ? {} : { expected },
      ...detail.library === 'team' ? { approved } : {},
    }
    const result = await edit(activeSessionId, detail.card.id, patch, options)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setEditing(false)
    await loadOverview(activeSessionId)
    await openCard(detail.card.id)
  }, [busy, activeSessionId, detail, edit, form, expected, approved, loadOverview, openCard])

  const beginEdit = useCallback((): void => {
    /* v8 ignore next -- the edit button renders only from an open detail, so the detail is always present here */
    if (detail === undefined) return
    setEditId(detail.card.id)
    setExpected({ mtime: detail.mtime, size: detail.size })
    setForm(formFromCard(detail.card))
    setApproved(false)
    setError(undefined)
    setEditing(true)
  }, [detail])

  /**
   * The action buttons render only after the overview resolved, so the session
   * and the detail are present; a missing injected face is a broken
   * composition that fails loud at the click instead of rendering a dead button.
   */
  const actionSession = activeSessionId as SessionId
  const runPromote = (target: CardStatus): void => {
    /* v8 ignore next -- missing-face throw: designed fail-loud; React 18 routes handler throws to an uncaught error */
    if (detail === undefined || promote === undefined) throw new Error('kb workbench: promote face is missing')
    void runAction(() => promote(actionSession, detail.card.id, target))
  }
  const runReview = (approvedFlag: boolean): void => {
    /* v8 ignore next -- same uncaught-error constraint as runPromote */
    if (detail === undefined || review === undefined) throw new Error('kb workbench: review face is missing')
    void runAction(() => review(actionSession, detail.card.id, approvedFlag))
  }
  const runArchive = (): void => {
    /* v8 ignore next -- same uncaught-error constraint as runPromote */
    if (detail === undefined || archive === undefined) throw new Error('kb workbench: archive face is missing')
    void runAction(() => archive(actionSession, detail.card.id))
  }
  const runRevive = (): void => {
    /* v8 ignore next -- same uncaught-error constraint as runPromote */
    if (detail === undefined || revive === undefined) throw new Error('kb workbench: revive face is missing')
    void runAction(() => revive(actionSession, detail.card.id))
  }
  const runEdit = (): void => {
    /* v8 ignore next -- same uncaught-error constraint as runPromote */
    if (edit === undefined) throw new Error('kb workbench: edit face is missing')
    beginEdit()
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

          <TeamDocs
            sessionId={actionSession}
            t={t}
            listDocs={listDocs}
            readDoc={readDoc}
            writeDoc={writeDoc}
            removeDoc={removeDoc}
          />

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

              {editing && form !== undefined && editId === detail.card.id ? (
                <form className={styles.editForm} onSubmit={(event) => { event.preventDefault(); void runSave() }}>
                  <label className={styles.editField}>
                    <span>{t('edit.title')}</span>
                    <input
                      className={styles.editInput}
                      value={form.title}
                      onChange={(event) => { setForm({ ...form, title: event.target.value }) }}
                    />
                  </label>
                  <label className={styles.editField}>
                    <span>{t('edit.type')}</span>
                    <select
                      className={styles.editInput}
                      value={form.type}
                      onChange={(event) => { setForm({ ...form, type: event.target.value as CardType }) }}
                    >
                      {CARD_TYPE_OPTIONS.map(type => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.condition')}</span>
                    <textarea
                      className={styles.editInput}
                      rows={2}
                      value={form.适用条件}
                      onChange={(event) => { setForm({ ...form, 适用条件: event.target.value }) }}
                    />
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.conclusion')}</span>
                    <textarea
                      className={styles.editInput}
                      rows={3}
                      value={form.核心结论}
                      onChange={(event) => { setForm({ ...form, 核心结论: event.target.value }) }}
                    />
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.do')}</span>
                    <textarea
                      className={styles.editInput}
                      rows={2}
                      value={form.应做}
                      onChange={(event) => { setForm({ ...form, 应做: event.target.value }) }}
                    />
                    <span className={styles.editHint}>{t('edit.listHint')}</span>
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.dont')}</span>
                    <textarea
                      className={styles.editInput}
                      rows={2}
                      value={form.不应做}
                      onChange={(event) => { setForm({ ...form, 不应做: event.target.value }) }}
                    />
                    <span className={styles.editHint}>{t('edit.listHint')}</span>
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.counterExample')}</span>
                    <textarea
                      className={styles.editInput}
                      rows={2}
                      value={form.反例}
                      onChange={(event) => { setForm({ ...form, 反例: event.target.value }) }}
                    />
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.source')}</span>
                    <input
                      className={styles.editInput}
                      value={form.来源}
                      onChange={(event) => { setForm({ ...form, 来源: event.target.value }) }}
                    />
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.owner')}</span>
                    <input
                      className={styles.editInput}
                      value={form.责任人}
                      onChange={(event) => { setForm({ ...form, 责任人: event.target.value }) }}
                    />
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.expiry')}</span>
                    <input
                      className={styles.editInput}
                      value={form.有效期}
                      onChange={(event) => { setForm({ ...form, 有效期: event.target.value }) }}
                    />
                  </label>
                  <label className={styles.editField}>
                    <span>{t('card.tags')}</span>
                    <input
                      className={styles.editInput}
                      value={form.标签}
                      onChange={(event) => { setForm({ ...form, 标签: event.target.value }) }}
                    />
                  </label>
                  {detail.library === 'team' && (
                    <label className={styles.editField}>
                      <input
                        type="checkbox"
                        checked={approved}
                        onChange={(event) => { setApproved(event.target.checked) }}
                      />
                      <span>{t('edit.approval')}</span>
                    </label>
                  )}
                  <div className={styles.actions}>
                    <button type="submit" className={styles.action} disabled={busy}>
                      {busy ? t('action.busy') : t('edit.save')}
                    </button>
                    <button type="button" className={styles.action} disabled={busy}
                      onClick={() => { setEditing(false) }}>
                      {t('edit.cancel')}
                    </button>
                  </div>
                </form>
              ) : (
                <div className={styles.actions}>
                  <button type="button" className={styles.action} disabled={busy} onClick={runEdit}>
                    {t('edit.button')}
                  </button>
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
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
