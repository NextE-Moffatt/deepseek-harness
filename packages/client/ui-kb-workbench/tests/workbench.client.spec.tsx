// @vitest-environment jsdom
/**
 * Workbench section component coverage: renders the flywheel metrics, the
 * merged pending-review list, the card detail, and the lifecycle actions
 * against driven props (a fake `useSessions` snapshot plus injected Remote
 * callbacks). Assertions target user-visible behavior, not internals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { CardId } from '@deepseek-ai/dsh-kb-core/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { KbWorkbenchCard, KbWorkbenchOverview } from '@deepseek-ai/dsh-kb-web/client'
import { WorkbenchSection, type WorkbenchSectionProps } from '../src/client/WorkbenchSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = 'session-a' as SessionId
const OTHER = 'session-b' as SessionId
const CARD = 'rule-20260818-001' as CardId
const TEAM_CARD = 'rule-20260818-002'
const t: Injected['t'] = makeTranslate(zh)

function sessionState(): SessionListState {
  return {
    ids: [SESSION, OTHER],
    byId: {
      [SESSION]: { sessionId: SESSION, updatedAt: 2, running: false, blank: false, cwd: '/ws/a' } as never,
      [OTHER]: { sessionId: OTHER, updatedAt: 1, running: false, blank: false, cwd: '/ws/b' } as never,
    },
    current: SESSION,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function overviewFixture(): KbWorkbenchOverview {
  return {
    scanDate: '2026-08-19',
    freshness: {
      overdue: [{ id: CARD, title: '过期规则', library: 'personal', status: 'ready', grade: 'verify', 有效期: '2026-08-01', daysLeft: -18, heat: 2, recommend: 'renew' }],
      expiringSoon: [{ id: TEAM_CARD, title: '临期规则', library: 'team', status: 'pending', grade: 'pending', 有效期: '2026-08-25', daysLeft: 6, heat: 0, recommend: 'review' }],
      total: 2,
    },
    blindSpots: [{
      sessionId: 'blind-1', at: '2026-08-18T10:00:00.000Z',
      consumed: [CARD], excerpt: '这段会话消费了知识但没有沉淀卡片',
    }],
    heat: [],
    metrics: {
      injections: 7,
      promotions: 3,
      pendingReview: 2,
      blindSpots: 1,
      topHeat: [{ cardId: CARD, title: '过期规则', count: 4, lastSession: 's1' }],
    },
  }
}

function cardFixture(over: Partial<KbWorkbenchCard> = {}): KbWorkbenchCard {
  return {
    library: 'personal',
    tier: 'P2',
    path: '/ws/a/kb/cards/P2/rule-20260818-001.md',
    grade: 'pending',
    mtime: 100,
    size: 200,
    card: {
      id: CARD, type: 'rule', title: '过期规则', 库: 'personal', 状态: 'draft',
      适用条件: '值班收到告警', 核心结论: '先确认影响面', 应做: ['确认影响面'], 不应做: ['直接重启'],
      来源: 'https://example.com', 责任人: '本人', 有效期: '2099-01-01', 标签: ['告警'],
    },
    ...over,
  }
}

type Injected = Required<Omit<WorkbenchSectionProps, 'useSessions' | 'useWorkspaces'>>

/** A driven `useSessions` hook returning the given snapshot through the selector. */
function sessionHook(state: () => SessionListState): WorkbenchSectionProps['useSessions'] {
  return selector => selector(state())
}

function injected(over: Partial<Injected> = {}): Injected {
  return {
    t,
    overview: vi.fn(async () => ({ ok: true as const, value: overviewFixture() })),
    card: vi.fn(async () => ({ ok: true as const, value: cardFixture() })),
    promote: vi.fn(async () => ({ ok: true as const, value: undefined })),
    archive: vi.fn(async () => ({ ok: true as const, value: undefined })),
    revive: vi.fn(async () => ({ ok: true as const, value: undefined })),
    review: vi.fn(async () => ({ ok: true as const, value: undefined })),
    edit: vi.fn(async () => ({ ok: true as const, value: cardFixture() })),
    ...over,
  }
}

function renderSection(props: Injected, sessions: () => SessionListState = sessionState): void {
  const useWorkspaces = (selector: (state: unknown) => unknown): unknown => selector({ ids: [], byId: {} })
  render(<WorkbenchSection useSessions={sessionHook(sessions)} useWorkspaces={useWorkspaces as never} {...props} />)
}

/** The freshness review row that carries the given badge and title. */
function freshnessRowOf(badge: string, title: string): HTMLElement {
  const li = screen.getByText(badge).closest('li')!
  return within(li).getByText(title) as HTMLElement
}

describe('workbench section', () => {
  it('renders the flywheel metrics, the top-heat list, and the merged review rows', async () => {
    renderSection(injected())
    // Metrics tiles.
    expect(await screen.findByText('7')).toBeDefined()
    expect(screen.getByText('3')).toBeDefined()
    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getByText('1')).toBeDefined()
    // Top heat with the resolved title.
    const topHeat = screen.getByText('热度 Top').parentElement!
    expect(within(topHeat).getByText('过期规则')).toBeDefined()
    // Freshness rows.
    expect(screen.getByText('已过期')).toBeDefined()
    expect(screen.getByText('即将过期')).toBeDefined()
    // The blind spot row with its excerpt and consumed card link.
    const blindSpot = screen.getByText('复盘盲点').closest('li')!
    expect(within(blindSpot).getByText('这段会话消费了知识但没有沉淀卡片')).toBeDefined()
    expect(within(blindSpot).getByText(CARD)).toBeDefined()
  })

  it('renders the empty states when there is nothing to review', async () => {
    const empty = overviewFixture() as KbWorkbenchOverview & {
      freshness: { overdue: unknown[]; expiringSoon: unknown[]; total: number }
      blindSpots: unknown[]
      metrics: { pendingReview: number; blindSpots: number; topHeat: unknown[] }
    }
    empty.freshness.overdue = []
    empty.freshness.expiringSoon = []
    empty.freshness.total = 0
    empty.blindSpots = []
    empty.metrics.pendingReview = 0
    empty.metrics.blindSpots = 0
    empty.metrics.topHeat = []
    renderSection(injected({ overview: vi.fn(async () => ({ ok: true as const, value: empty })) }))
    expect(await screen.findByText('没有待复核项')).toBeDefined()
    expect(screen.getByText('暂无')).toBeDefined()
  })

  it('shows the unavailable state when no session has a workspace', async () => {
    const noWorkspace = sessionState()
    for (const id of noWorkspace.ids) delete noWorkspace.byId[id]!.cwd
    renderSection(injected(), () => noWorkspace)
    expect(screen.getByText('知识库工作台不可用')).toBeDefined()
    expect(screen.getByText(/未挂载 dsh-kb-core/)).toBeDefined()
  })

  it('surfaces an overview failure with a retry that reloads', async () => {
    const overview = vi.fn(async (): Promise<RemoteResult<KbWorkbenchOverview>> =>
      ({ ok: false as const, error: { code: 'service-unavailable', message: 'kb unavailable', details: {} } }))
    renderSection(injected({ overview }))
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText('kb unavailable')).toBeDefined()
    overview.mockResolvedValueOnce({ ok: true as const, value: overviewFixture() })
    fireEvent.click(screen.getByText('重试'))
    expect(await screen.findByText('7')).toBeDefined()
  })

  it('opens a card detail from a review row and from a top-heat entry', async () => {
    const face = injected()
    renderSection(face)
    const title = await screen.findAllByText('过期规则')
    expect(title.length).toBeGreaterThan(0)
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(await screen.findByText('值班收到告警')).toBeDefined()
    expect(face.card).toHaveBeenCalledWith(SESSION, CARD)
    // The detail shows the draft card's promotion action.
    expect(screen.getByText('晋升待核')).toBeDefined()
  })

  it('opens a card detail from a top-heat entry', async () => {
    const face = injected()
    renderSection(face)
    const topHeat = (await screen.findByText('热度 Top')).parentElement!
    fireEvent.click(within(topHeat).getByText('过期规则'))
    expect(await screen.findByText('值班收到告警')).toBeDefined()
    expect(face.card).toHaveBeenCalledWith(SESSION, CARD)
  })

  it('runs the lifecycle action for the card state and refreshes the overview', async () => {
    const face = injected()
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    await screen.findByText('晋升待核')
    fireEvent.click(screen.getByText('晋升待核'))
    await waitFor(() => { expect(face.promote).toHaveBeenCalledWith(SESSION, CARD, 'pending') })
    // Success refreshes the merged view.
    await waitFor(() => { expect(face.overview).toHaveBeenCalledTimes(2) })
  })

  it('surfaces an action failure without hiding the detail', async () => {
    const face = injected({
      promote: vi.fn(async () => ({ ok: false as const, error: { code: 'transition-invalid', message: 'invalid transition', details: {} } })),
    })
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    await screen.findByText('晋升待核')
    fireEvent.click(screen.getByText('晋升待核'))
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText('invalid transition')).toBeDefined()
    expect(screen.getByText('晋升待核')).toBeDefined()
  })

  it('offers the team actions per card state: review, archive, revive', async () => {
    let currentCard: KbWorkbenchCard = cardFixture({ library: 'team', tier: 'team', card: { ...cardFixture().card, id: TEAM_CARD as CardId, title: '临期规则', 库: 'team', 状态: 'pending' } })
    const face = injected({
      card: vi.fn(async () => ({ ok: true as const, value: currentCard })),
      review: vi.fn(async (_session: string, _id: string, approved: boolean) => {
        if (approved) {
          currentCard = cardFixture({ library: 'team', tier: 'team', card: { ...cardFixture().card, id: TEAM_CARD as CardId, title: '临期规则', 库: 'team', 状态: 'ready' } })
        }
        return { ok: true as const, value: undefined }
      }),
      archive: vi.fn(async () => {
        currentCard = cardFixture({ library: 'team', tier: 'team', card: { ...cardFixture().card, id: TEAM_CARD as CardId, title: '临期规则', 库: 'team', 状态: 'archived' } })
        return { ok: true as const, value: undefined }
      }),
      revive: vi.fn(async () => {
        currentCard = cardFixture({ library: 'team', tier: 'team', card: { ...cardFixture().card, id: TEAM_CARD as CardId, title: '临期规则', 库: 'team', 状态: 'revived' } })
        return { ok: true as const, value: undefined }
      }),
    })
    renderSection(face)
    // Team pending → approve/reject review; approval refreshes to the ready card.
    await screen.findByText('临期规则')
    fireEvent.click(screen.getByText('临期规则'))
    expect(await screen.findByText('复核通过')).toBeDefined()
    expect(screen.getByText('复核不通过')).toBeDefined()
    // The reject verb rides the same remote and refreshes nothing.
    fireEvent.click(screen.getByText('复核不通过'))
    await waitFor(() => { expect(face.review).toHaveBeenCalledWith(SESSION, TEAM_CARD, false) })
    fireEvent.click(screen.getByText('复核通过'))
    await waitFor(() => { expect(face.review).toHaveBeenCalledWith(SESSION, TEAM_CARD, true) })
    // Ready → archive; the refresh re-renders the ready detail.
    expect(await screen.findByText('归档')).toBeDefined()
    fireEvent.click(screen.getByText('归档'))
    await waitFor(() => { expect(face.archive).toHaveBeenCalledWith(SESSION, TEAM_CARD) })
    // Archived → revive.
    expect(await screen.findByText('复活')).toBeDefined()
    fireEvent.click(screen.getByText('复活'))
    await waitFor(() => { expect(face.revive).toHaveBeenCalledWith(SESSION, TEAM_CARD) })
  })

  it('renders every grade label and the optional counter-example row', async () => {
    const face = injected()
    const base = cardFixture()
    const verified = { ...base, grade: 'verified' as const, card: { ...base.card, 反例: '踩过一次坑' } }
    const verify = { ...base, grade: 'verify' as const }
    const withoutSource = { ...base, card: { ...base.card } } as KbWorkbenchCard
    delete (withoutSource.card as Partial<typeof base.card>).来源
    vi.mocked(face.card)
      .mockResolvedValueOnce({ ok: true as const, value: verified })
      .mockResolvedValueOnce({ ok: true as const, value: verify })
      .mockResolvedValueOnce({ ok: true as const, value: withoutSource })
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(await screen.findByText('已验证')).toBeDefined()
    expect(screen.getByText('踩过一次坑')).toBeDefined()
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(await screen.findByText('需复核')).toBeDefined()
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(await screen.findByText('适用条件')).toBeDefined()
    expect(screen.queryByText('来源')).toBeNull()
  })

  it('opens a consumed card from a blind-spot row', async () => {
    const face = injected()
    renderSection(face)
    const blindSpot = (await screen.findByText('复盘盲点')).closest('li')!
    fireEvent.click(within(blindSpot).getByText(CARD))
    expect(await screen.findByText('值班收到告警')).toBeDefined()
    expect(face.card).toHaveBeenCalledWith(SESSION, CARD)
  })

  it('degrades to the loading hint when the overview face is absent', async () => {
    renderSection(injected({ overview: undefined as never }))
    expect(screen.getByText('处理中…')).toBeDefined()
  })

  it('ignores card clicks when the card face is absent', async () => {
    renderSection(injected({ card: undefined as never }))
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(screen.queryByText('适用条件')).toBeNull()
  })

  it('switches the workspace via the selector and reloads the overview', async () => {
    const face = injected()
    renderSection(face)
    await screen.findByText('7')
    const select = screen.getByLabelText('工作区') as HTMLSelectElement
    act(() => { fireEvent.change(select, { target: { value: OTHER } }) })
    await waitFor(() => { expect(face.overview).toHaveBeenLastCalledWith(OTHER) })
  })

  it('offers the promote-ready action for a personal pending card', async () => {
    const face = injected({
      card: vi.fn(async () => ({ ok: true as const, value: cardFixture({ card: { ...cardFixture().card, 状态: 'pending' } }) })),
    })
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    const button = await screen.findByText('晋升引用池')
    fireEvent.click(button)
    await waitFor(() => { expect(face.promote).toHaveBeenCalledWith(SESSION, CARD, 'ready') })
  })

  it('renders no actions for a personal ready card or an unknown team status', async () => {
    const face = injected()
    vi.mocked(face.card)
      .mockResolvedValueOnce({ ok: true as const, value: cardFixture({ card: { ...cardFixture().card, 状态: 'ready' } }) })
      .mockResolvedValueOnce({ ok: true as const, value: cardFixture({ library: 'team', tier: 'team', card: { ...cardFixture().card, 库: 'team', 状态: 'draft' } }) })
    renderSection(face)
    // Personal ready card: no lifecycle action.
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(await screen.findByText('适用条件')).toBeDefined()
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull()
    // Team draft card (impossible in practice): the actionOf fall-through.
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(await screen.findByText('适用条件')).toBeDefined()
    expect(screen.queryByRole('button', { name: '复核通过' })).toBeNull()
  })

  it('clears the detail and surfaces the error when a card read fails', async () => {
    const face = injected({
      card: vi.fn(async () => ({ ok: false as const, error: { code: 'not-found', message: 'card not found: x', details: {} } })),
    })
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText('card not found: x')).toBeDefined()
    expect(screen.queryByText('适用条件')).toBeNull()
  })

  it('refreshes the overview after an action with no detail open', async () => {
    const face = injected()
    renderSection(face)
    await screen.findByText('7')
    // No detail is open; the blind-spot consumed link opens one, then the
    // action refreshes the view and the detail.
    const blindSpot = screen.getByText('复盘盲点').closest('li')!
    fireEvent.click(within(blindSpot).getByText(CARD))
    await screen.findByText('晋升待核')
    fireEvent.click(screen.getByText('晋升待核'))
    await waitFor(() => { expect(face.overview).toHaveBeenCalledTimes(2) })
  })

  it('renders the loading hint while the overview is pending', async () => {
    const face = injected({
      overview: vi.fn(async (_s: SessionId, _t?: string): Promise<RemoteResult<KbWorkbenchOverview>> =>
        new Promise(() => {})),
    })
    renderSection(face)
    expect(screen.getByText('处理中…')).toBeDefined()
  })

  it('degrades to empty labels when the locale face is absent', async () => {
    const face = injected()
    renderSection({ ...face, t: undefined as never })
    // The data still renders; the copy falls back to the empty default.
    expect(await screen.findByText('7')).toBeDefined()
  })

  it('falls back to the first candidate when no session is current', async () => {
    const state = sessionState()
    state.current = undefined
    const face = injected()
    renderSection(face, () => state)
    await waitFor(() => { expect(face.overview).toHaveBeenCalledWith(SESSION) })
  })

  it('dedupes sessions that share a workspace, keeping the newer one', async () => {
    const state = sessionState()
    const twin = 'session-c' as SessionId
    state.ids = [SESSION, twin, OTHER]
    state.byId[twin] = { sessionId: twin, updatedAt: 9, running: false, blank: false, cwd: '/ws/a' } as never
    const face = injected()
    renderSection(face, () => state)
    // The newer twin wins the /ws/a seat; the selector shows two workspaces.
    await screen.findByText('7')
    expect(screen.getByRole('option', { name: '/ws/a' })).toBeDefined()
    expect(screen.getByRole('option', { name: '/ws/b' })).toBeDefined()
  })

  it('keeps the first session when a shared-workspace twin is older or dateless', async () => {
    const state = sessionState()
    const twin = 'session-c' as SessionId
    state.ids = [SESSION, twin]
    state.byId[twin] = { sessionId: twin, updatedAt: 1, running: false, blank: false, cwd: '/ws/a' } as never
    const face = injected()
    renderSection(face, () => state)
    await screen.findByText('7')
    // The older twin loses the /ws/a seat; the newer session stays selected.
    await waitFor(() => { expect(face.overview).toHaveBeenCalledWith(SESSION) })

    // Dateless sessions also lose: both `?? 0` fallbacks compare as zero.
    const dateless = sessionState()
    const late = 'session-d' as SessionId
    dateless.ids = [SESSION, late]
    delete (dateless.byId[SESSION] as { updatedAt?: number }).updatedAt
    dateless.byId[late] = { sessionId: late, running: false, blank: false, cwd: '/ws/a' } as never
    const lateFace = injected()
    renderSection(lateFace, () => dateless)
    await screen.findByText('7')
    await waitFor(() => { expect(lateFace.overview).toHaveBeenCalledWith(SESSION) })
  })

  it('renders a blind spot without consumed cards', async () => {
    const overview = overviewFixture() as KbWorkbenchOverview & {
      blindSpots: unknown[]
      metrics: { blindSpots: number }
    }
    overview.blindSpots = [{ sessionId: 'blind-2', at: '2026-08-18T10:00:00.000Z', consumed: [], excerpt: '无引用盲点' }]
    overview.metrics.blindSpots = 1
    renderSection(injected({ overview: vi.fn(async () => ({ ok: true as const, value: overview })) }))
    const blindSpot = (await screen.findByText('复盘盲点')).closest('li')!
    expect(within(blindSpot).getByText('无引用盲点')).toBeDefined()
    expect(within(blindSpot).queryByRole('button')).toBeNull()
  })
})

describe('card editing', () => {
  it('opens the edit form from the detail and saves a changed title with the expected identity', async () => {
    const face = injected()
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    fireEvent.click(await screen.findByText('编辑'))
    // The form is seeded from the current card.
    const title = screen.getByLabelText('标题') as HTMLInputElement
    expect(title.value).toBe('过期规则')
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '新标题' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(face.edit).toHaveBeenCalledWith(
        SESSION, CARD,
        expect.objectContaining({ title: '新标题' }),
        { expected: { mtime: 100, size: 200 } },
      )
    })
    // Success exits the form and refreshes the detail + overview.
    await waitFor(() => { expect(face.overview).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText('保存')).toBeNull()
  })

  it('splits 应做 lines and 标签 separators into the patch lists', async () => {
    const face = injected()
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    fireEvent.click(await screen.findByText('编辑'))
    fireEvent.change(screen.getByLabelText(/^应做/), { target: { value: '动作一\n动作二' } })
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '告警、值班' } })
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'howto' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(face.edit).toHaveBeenCalledWith(SESSION, CARD, expect.objectContaining({
        type: 'howto',
        应做: ['动作一', '动作二'],
        标签: ['告警', '值班'],
      }), expect.anything())
    })
  })

  it('edits every remaining form field and submits the full patch', async () => {
    const face = injected()
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    fireEvent.click(await screen.findByText('编辑'))
    fireEvent.change(screen.getByLabelText('适用条件'), { target: { value: '新条件' } })
    fireEvent.change(screen.getByLabelText('核心结论'), { target: { value: '新结论' } })
    fireEvent.change(screen.getByLabelText(/^不应做/), { target: { value: '新反动作' } })
    fireEvent.change(screen.getByLabelText('反例'), { target: { value: '新反例' } })
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'https://example.com/new' } })
    fireEvent.change(screen.getByLabelText('责任人'), { target: { value: '李四' } })
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: '2027-01-01' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(face.edit).toHaveBeenCalledWith(SESSION, CARD, expect.objectContaining({
        适用条件: '新条件',
        核心结论: '新结论',
        不应做: ['新反动作'],
        反例: '新反例',
        来源: 'https://example.com/new',
        责任人: '李四',
        有效期: '2027-01-01',
      }), expect.anything())
    })
  })

  it('seeds the optional fields, including a cleared 来源', async () => {
    const base = cardFixture()
    const withoutSource = { ...base, card: { ...base.card } } as KbWorkbenchCard
    delete (withoutSource.card as Partial<typeof base.card>).来源
    const withCounter = { ...withoutSource, card: { ...withoutSource.card, 反例: '踩过一次坑' } }
    const face = injected({ card: vi.fn(async () => ({ ok: true as const, value: withCounter })) })
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    fireEvent.click(await screen.findByText('编辑'))
    const counterExample = screen.getByLabelText('反例') as HTMLTextAreaElement
    expect(counterExample.value).toBe('踩过一次坑')
    const source = screen.getByLabelText('来源') as HTMLInputElement
    expect(source.value).toBe('')
  })

  it('requires the team confirmation and passes approved for a team card', async () => {
    const face = injected({
      card: vi.fn(async () => ({ ok: true as const, value: cardFixture({
        library: 'team', tier: 'team',
        card: { ...cardFixture().card, 库: 'team', 状态: 'ready' },
      }) })),
    })
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    fireEvent.click(await screen.findByText('编辑'))
    const confirm = screen.getByLabelText('已确认将修改写入团队共享知识库') as HTMLInputElement
    expect(confirm.checked).toBe(false)
    fireEvent.click(confirm)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(face.edit).toHaveBeenCalledWith(SESSION, CARD, expect.anything(), expect.objectContaining({ approved: true }))
    })
  })

  it('surfaces a conflict error and stays in the form', async () => {
    const face = injected({
      edit: vi.fn(async () => ({ ok: false as const, error: { code: 'conflict', message: '卡片已被其他会话修改，请刷新后重试（x）', details: {} } })),
    })
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    fireEvent.click(await screen.findByText('编辑'))
    fireEvent.click(screen.getByText('保存'))
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText(/已被其他会话修改/)).toBeDefined()
    expect(screen.getByText('保存')).toBeDefined()
  })

  it('cancels the form without calling edit', async () => {
    const face = injected()
    renderSection(face)
    await screen.findByText('已过期')
    fireEvent.click(freshnessRowOf('已过期', '过期规则'))
    fireEvent.click(await screen.findByText('编辑'))
    fireEvent.click(screen.getByText('取消'))
    expect(screen.queryByText('保存')).toBeNull()
    expect(face.edit).not.toHaveBeenCalled()
  })
})
