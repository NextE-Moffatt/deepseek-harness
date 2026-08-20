/**
 * Unit coverage of `@deepseek-ai/dsh-kb-web`: the Remote service's read
 * projections and lifecycle actions against a live session store and a stubbed
 * kb boundary (the filesystem-heavy freshness/heat reads stay behind the stub;
 * the loader-composition spec covers the real chain).
 */
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { KbService } from '@deepseek-ai/dsh-kb-core'
import { todayString } from '@deepseek-ai/dsh-kb-core'
import KbWorkbenchService, {
  DEFAULT_BLIND_SPOT_LIMIT, DEFAULT_TOP_HEAT_COUNT, resolveConfig,
} from '@deepseek-ai/dsh-kb-web'
import type { KbWebConfig } from '@deepseek-ai/dsh-kb-web'
import type { FreshnessReview, HeatRow } from '@deepseek-ai/dsh-kb-core'

const CARD = 'rule-20260818-001'
const OTHER_CARD = 'rule-20260818-002'
const WORKSPACE_SESSION = SessionId('kb-web-workspace-session')
const DOC = 'docs/architecture.md'
const NESTED_DOC = 'docs/新人专区/onboarding.md'

const freshness: FreshnessReview = {
  overdue: [{
    id: CARD, title: '过期卡片', library: 'personal', status: 'ready', grade: 'verify',
    有效期: '2026-08-01', daysLeft: -18, heat: 2, recommend: 'renew',
  }],
  expiringSoon: [{
    id: OTHER_CARD, title: '临期卡片', library: 'team', status: 'ready', grade: 'verified',
    有效期: '2026-08-25', daysLeft: 6, heat: 0, recommend: 'renew',
  }],
  total: 2,
}

const heat: HeatRow[] = [
  { cardId: CARD as never, count: 3, lastAt: '2026-08-18T10:00:00.000Z', sessions: ['s1', 's2'], packs: ['包'] },
  { cardId: OTHER_CARD as never, count: 1, lastAt: '2026-08-17T10:00:00.000Z', sessions: ['s1'], packs: ['包'] },
]

/** A `kb/injected` event consuming the given card ids. */
function injected(ids: readonly string[], pack = '包'): SessionEvent {
  return {
    type: 'kb/injected',
    data: { pack, cardIds: ids, sections: ids.map(name => ({ name, text: '内容' })) },
    seq: 0,
    time: 1_700_000_000_000,
  } as SessionEvent
}

/** The callable mock handles of the stubbed kb service. */
interface KbMocks {
  freshnessReview: ReturnType<typeof vi.fn>
  heat: ReturnType<typeof vi.fn>
  readCard: ReturnType<typeof vi.fn>
  personalCard: ReturnType<typeof vi.fn>
  teamCard: ReturnType<typeof vi.fn>
  promote: ReturnType<typeof vi.fn>
  archiveTeam: ReturnType<typeof vi.fn>
  reviveTeam: ReturnType<typeof vi.fn>
  reviewTeam: ReturnType<typeof vi.fn>
  editCard: ReturnType<typeof vi.fn>
  listTeamDocs: ReturnType<typeof vi.fn>
  readTeamDoc: ReturnType<typeof vi.fn>
  teamDocInfo: ReturnType<typeof vi.fn>
  writeTeamDoc: ReturnType<typeof vi.fn>
  removeTeamDoc: ReturnType<typeof vi.fn>
}

/** Build a stubbed kb service exposing the workbench's call surface. */
function kbLike(overrides: Partial<KbService> = {}): { kb: KbService; mocks: KbMocks } {
  const mocks: KbMocks = {
    freshnessReview: vi.fn(async () => freshness),
    heat: vi.fn(async () => heat),
    readCard: vi.fn(async () => ({ card: { id: CARD, title: '热度卡片' }, tier: 'P2', path: '/tmp/card.md' })),
    personalCard: vi.fn(async () => undefined),
    teamCard: vi.fn(async () => undefined),
    promote: vi.fn(async () => ({ card: { id: CARD, 状态: 'ready' }, from: 'draft', to: 'ready', path: '/tmp/card.md' })),
    archiveTeam: vi.fn(async () => ({ card: { id: CARD, 状态: 'archived' }, from: 'ready', path: '/tmp/card.md' })),
    reviveTeam: vi.fn(async () => ({ card: { id: CARD, 状态: 'revived' }, from: 'archived', path: '/tmp/card.md' })),
    reviewTeam: vi.fn(async (_root: string, _id: string, approved: boolean) => ({
      card: { id: CARD, 状态: approved ? 'ready' : 'pending' },
      changed: approved,
    })),
    editCard: vi.fn(async (_root: string, _id: string, patch: Record<string, unknown>) => ({
      card: { id: CARD, ...patch },
      library: 'personal',
      tier: 'P2',
      path: '/ws/kb/cards/P2/x.md',
      fields: ['title'],
    })),
    listTeamDocs: vi.fn(async () => [DOC, NESTED_DOC]),
    readTeamDoc: vi.fn(async () => '# 架构说明'),
    teamDocInfo: vi.fn(async () => ({ path: DOC, mtime: 1, size: 11 })),
    writeTeamDoc: vi.fn(async () => ({ path: DOC, mtime: 2, size: 22 })),
    removeTeamDoc: vi.fn(async () => ({ path: DOC })),
  }
  const kb = { config: { recapPath: 'kb/.kb-recap.jsonl' }, ...mocks, ...overrides } as unknown as KbService
  return { kb, mocks }
}

interface Harness {
  ctx: Context
  workspace: string
  session: Session
  kb: KbService
}

const roots: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.length = 0
  vi.restoreAllMocks()
})

/** Mount the workbench service with a live session store and a stubbed kb. */
async function harness(config: Record<string, unknown> = {}): Promise<Harness & { mocks: KbMocks }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const workspace = await tempDir('dsh-kb-web-')
  const { kb, mocks } = kbLike()
  ctx.provide('kb', kb)
  await ctx.plugin(KbWorkbenchService, config)
  const session = ctx.sessions.create(WORKSPACE_SESSION, { meta: { cwd: workspace } })
  return { ctx, workspace, session, kb, mocks }
}

/** A store-entered workspace session whose log holds the given events. */
function workspaceSession(ctx: Context, id: string, cwd: string, events: readonly SessionEvent[]): Session {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      session.append(event.type, event.data, { surfaceOp: 'append' })
    } else {
      session.append(event.type, event.data)
    }
  }
  return session
}

describe('resolveConfig', () => {
  it('applies the defaults', () => {
    expect(resolveConfig({})).toEqual({ blindSpotLimit: DEFAULT_BLIND_SPOT_LIMIT, topHeatCount: DEFAULT_TOP_HEAT_COUNT })
  })

  it('accepts explicit positive integers', () => {
    expect(resolveConfig({ blindSpotLimit: 5, topHeatCount: 2 })).toEqual({ blindSpotLimit: 5, topHeatCount: 2 })
  })

  it.each([
    [{ blindSpotLimit: 0 }, /blindSpotLimit must be a positive integer/],
    [{ blindSpotLimit: 1.5 }, /blindSpotLimit must be a positive integer/],
    [{ blindSpotLimit: 'many' }, /blindSpotLimit must be a positive integer/],
    [{ topHeatCount: 0 }, /topHeatCount must be a positive integer/],
    [{ topHeatCount: -1 }, /topHeatCount must be a positive integer/],
  ] as const)('fails loud on %o', (config, pattern) => {
    expect(() => resolveConfig(config as KbWebConfig)).toThrow(pattern)
  })
})

describe('overview', () => {
  it('requires a session with a workspace', async () => {
    const { ctx, session } = await harness()
    const detached = Session.create(SessionId('no-cwd'))
    await expect(ctx.kbWorkbench.overview(detached)).rejects.toThrow(/requires a session with a workspace/)
    await expect(ctx.kbWorkbench.overview(session)).resolves.toBeDefined()
  })

  it('merges freshness, unrecorded blind spots, heat, and the flywheel metrics', async () => {
    const { ctx, workspace, session } = await harness()
    // A blind spot: consumed knowledge, produced no card. A healthy session:
    // consumed, produced, and promoted.
    workspaceSession(ctx, 'blind', workspace, [
      injected([CARD]),
      { type: 'user/message', data: { content: [{ type: 'text', text: '复盘这段会话' }] }, seq: 0, time: 1 } as SessionEvent,
    ])
    workspaceSession(ctx, 'healthy', workspace, [
      injected([CARD]),
      { type: 'kb/write', data: { id: 'x' }, seq: 0, time: 1 } as SessionEvent,
      { type: 'kb/promote', data: { id: 'x', from: 'draft', to: 'ready' }, seq: 0, time: 1 } as SessionEvent,
    ])
    const today = '2026-08-19'
    const overview = await ctx.kbWorkbench.overview(session, today)
    expect(overview.scanDate).toBe(today)
    expect(overview.freshness).toEqual(freshness)
    expect(overview.heat).toEqual(heat)
    // The blind spot is listed once with its consumed ids and excerpt.
    expect(overview.blindSpots).toHaveLength(1)
    expect(overview.blindSpots[0]).toMatchObject({ sessionId: SessionId('blind'), consumed: [CARD] })
    expect(overview.blindSpots[0]!.excerpt).toContain('复盘这段会话')
    // The flywheel metrics project from the same surfaces.
    expect(overview.metrics.injections).toBe(4)
    expect(overview.metrics.pendingReview).toBe(2)
    expect(overview.metrics.blindSpots).toBe(1)
    // The healthy session's transition counts; the blind spot's injection does not.
    expect(overview.metrics.promotions).toBe(1)
    // The ledger has two rows, so the top-heat cap only bounds, never pads.
    expect(overview.metrics.topHeat).toHaveLength(2)
    expect(overview.metrics.topHeat[0]).toMatchObject({ cardId: CARD, title: '热度卡片', count: 3, lastSession: 's2' })
  })

  it('breaks heat ties by card id and degrades a session-less row to an empty last session', async () => {
    const { ctx, session, mocks } = await harness()
    mocks.heat.mockResolvedValueOnce([
      { cardId: 'case-20260818-004' as never, count: 3, lastAt: '', sessions: [], packs: [] },
      { cardId: CARD as never, count: 3, lastAt: '', sessions: ['s1'], packs: [] },
    ])
    const overview = await ctx.kbWorkbench.overview(session)
    expect(overview.metrics.injections).toBe(6)
    expect(overview.metrics.topHeat.map(entry => entry.cardId)).toEqual(['case-20260818-004', CARD])
    expect(overview.metrics.topHeat[0]!.lastSession).toBe('')
    expect(overview.metrics.topHeat[1]!.lastSession).toBe('s1')
  })

  it('caps the blind-spot list by config and never records positions', async () => {
    const { ctx, workspace, session } = await harness({ blindSpotLimit: 1 })
    for (let index = 0; index < 3; index += 1) {
      workspaceSession(ctx, `blind-${index}`, workspace, [injected([CARD])])
    }
    const overview = await ctx.kbWorkbench.overview(session)
    expect(overview.blindSpots).toHaveLength(1)
    // Detection without recording: the overview appends no kb/recap event and
    // the checkpoint file stays absent, so the tool/scheduler queue is intact.
    expect(session.events.some(event => event.type === 'kb/recap')).toBe(false)
    await expect(readFile(join(workspace, 'kb', '.kb-recap.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('defaults the scan date to today when omitted', async () => {
    const { ctx, session } = await harness()
    const overview = await ctx.kbWorkbench.overview(session)
    expect(overview.scanDate).toBe(todayString())
  })
})

describe('card', () => {
  it('reads a personal card with its tier, path, and derived grade', async () => {
    const { ctx, session, mocks } = await harness()
    const card = { id: CARD, title: '个人卡片', 状态: 'ready', 有效期: '2099-01-01' }
    mocks.personalCard.mockResolvedValueOnce({ card: card as never, tier: 'P2', path: '/ws/kb/cards/P2/x.md', mtime: 1, size: 1 })
    const view = await ctx.kbWorkbench.card(session, CARD)
    expect(view).toMatchObject({ library: 'personal', tier: 'P2', path: '/ws/kb/cards/P2/x.md', grade: 'verified' })
    expect(view.card).toEqual(card)
  })

  it('reads a team card with the team tier', async () => {
    const { ctx, session, mocks } = await harness()
    const card = { id: CARD, title: '团队卡片', 状态: 'pending', 有效期: '2099-01-01' }
    mocks.teamCard.mockResolvedValueOnce({ card: card as never, path: '/team/cards/x.md', mtime: 1, size: 1 })
    const view = await ctx.kbWorkbench.card(session, CARD)
    expect(view).toMatchObject({ library: 'team', tier: 'team', grade: 'pending' })
    expect(view.card).toEqual(card)
  })

  it('fails loud when no library holds the id', async () => {
    const { ctx, session } = await harness()
    await expect(ctx.kbWorkbench.card(session, 'missing-1')).rejects.toThrow('card not found: missing-1')
  })
})

describe('lifecycle actions', () => {
  it('promote applies the transition and appends kb/promote to the workbench session log', async () => {
    const { ctx, session, mocks } = await harness()
    const result = await ctx.kbWorkbench.promote(session, CARD, 'ready', '上线')
    expect(mocks.promote).toHaveBeenCalledWith(expect.any(String), CARD, 'ready', '上线')
    expect(result.to).toBe('ready')
    const event = session.events.find(candidate => candidate.type === 'kb/promote')
    expect(event?.data).toEqual({ id: CARD, from: 'draft', to: 'ready', evidence: '上线' })
  })

  it('promote refuses targets outside the promotion subset without touching the log', async () => {
    const { ctx, session, mocks } = await harness()
    await expect(ctx.kbWorkbench.promote(session, CARD, 'archived')).rejects.toThrow(/target must be one of pending, ready/)
    expect(mocks.promote).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'kb/promote')).toBe(false)
  })

  it('archive and revive append the retire/restore transitions', async () => {
    const { ctx, session } = await harness()
    await ctx.kbWorkbench.archive(session, CARD)
    await ctx.kbWorkbench.revive(session, CARD)
    const events = session.events.filter(event => event.type === 'kb/promote').map(event => event.data)
    expect(events).toEqual([
      { id: CARD, from: 'ready', to: 'archived' },
      { id: CARD, from: 'archived', to: 'revived' },
    ])
  })

  it('review appends kb/promote only on approval', async () => {
    const { ctx, session, mocks } = await harness()
    await ctx.kbWorkbench.review(session, CARD, true)
    await ctx.kbWorkbench.review(session, CARD, false)
    const events = session.events.filter(event => event.type === 'kb/promote')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toEqual({ id: CARD, from: 'pending', to: 'ready' })
    expect(mocks.reviewTeam).toHaveBeenCalledTimes(2)
  })
})

describe('edit', () => {
  it('applies the patch, appends kb/edit with the changed fields, and returns the refreshed card', async () => {
    const { ctx, session, mocks } = await harness()
    const edited = { id: CARD, title: '新标题', 状态: 'draft', 有效期: '2099-01-01' }
    mocks.editCard.mockResolvedValueOnce({
      card: edited, library: 'personal', tier: 'P2', path: '/ws/kb/cards/P2/x.md', fields: ['title'],
    })
    mocks.personalCard.mockResolvedValueOnce({ card: edited as never, tier: 'P2', path: '/ws/kb/cards/P2/x.md', mtime: 2, size: 2 })
    const view = await ctx.kbWorkbench.edit(session, CARD, { title: '新标题' })
    expect(mocks.editCard).toHaveBeenCalledWith(expect.any(String), CARD, { title: '新标题' }, undefined)
    expect(view).toMatchObject({ library: 'personal', tier: 'P2', mtime: 2, size: 2 })
    expect(view.card.title).toBe('新标题')
    const event = session.events.find(candidate => candidate.type === 'kb/edit')
    expect(event?.data).toEqual({ id: CARD, library: 'personal', fields: ['title'] })
  })

  it('appends nothing for a no-op edit and passes the expected identity and approval through', async () => {
    const { ctx, session, mocks } = await harness()
    const edited = { id: CARD, title: '同标题', 状态: 'draft', 有效期: '2099-01-01' }
    mocks.editCard.mockResolvedValueOnce({
      card: edited, library: 'personal', tier: 'P2', path: '/ws/kb/cards/P2/x.md', fields: [],
    })
    mocks.personalCard.mockResolvedValueOnce({ card: edited as never, tier: 'P2', path: '/ws/kb/cards/P2/x.md', mtime: 1, size: 1 })
    await ctx.kbWorkbench.edit(session, CARD, { title: '同标题' }, { expected: { mtime: 1, size: 1 }, approved: true })
    expect(mocks.editCard).toHaveBeenCalledWith(
      expect.any(String), CARD, { title: '同标题' }, { expected: { mtime: 1, size: 1 }, approved: true },
    )
    expect(session.events.some(event => event.type === 'kb/edit')).toBe(false)
  })

  it('surfaces a conflict without appending kb/edit', async () => {
    const { ctx, session, mocks } = await harness()
    mocks.editCard.mockRejectedValueOnce(new Error('卡片已被其他会话修改，请刷新后重试（x）'))
    await expect(ctx.kbWorkbench.edit(session, CARD, { title: '新标题' })).rejects.toThrow(/已被其他会话修改/)
    expect(session.events.some(event => event.type === 'kb/edit')).toBe(false)
  })
})

describe('team docs', () => {
  it('lists the wiki documents and reads one with its identity', async () => {
    const { ctx, session, mocks } = await harness()
    expect(await ctx.kbWorkbench.listDocs(session)).toEqual([DOC, NESTED_DOC])
    mocks.readTeamDoc.mockResolvedValueOnce('# 更新的架构说明')
    mocks.teamDocInfo.mockResolvedValueOnce({ path: DOC, mtime: 9, size: 99 })
    const view = await ctx.kbWorkbench.readDoc(session, DOC)
    expect(view).toEqual({ path: DOC, content: '# 更新的架构说明', mtime: 9, size: 99 })
    expect(mocks.readTeamDoc).toHaveBeenCalledWith(expect.any(String), DOC)
  })

  it('writes a doc, appends kb/doc-write, and returns the refreshed view', async () => {
    const { ctx, session, mocks } = await harness()
    mocks.writeTeamDoc.mockResolvedValueOnce({ path: DOC, mtime: 2, size: 22 })
    const view = await ctx.kbWorkbench.writeDoc(session, DOC, '# 新内容', { approved: true })
    expect(mocks.writeTeamDoc).toHaveBeenCalledWith(expect.any(String), DOC, '# 新内容', { approved: true })
    expect(view.path).toBe(DOC)
    const event = session.events.find(candidate => candidate.type === 'kb/doc-write')
    expect(event?.data).toEqual({ path: DOC, size: 22 })
  })

  it('removes a doc, appends kb/doc-remove, and passes the approval through', async () => {
    const { ctx, session, mocks } = await harness()
    const removed = await ctx.kbWorkbench.removeDoc(session, DOC, { approved: true })
    expect(mocks.removeTeamDoc).toHaveBeenCalledWith(expect.any(String), DOC, { approved: true })
    expect(removed).toEqual({ path: DOC })
    const event = session.events.find(candidate => candidate.type === 'kb/doc-remove')
    expect(event?.data).toEqual({ path: DOC })
  })

  it('surfaces a write conflict or a denied approval without appending an event', async () => {
    const { ctx, session, mocks } = await harness()
    mocks.writeTeamDoc.mockRejectedValueOnce(new Error('团队文档写入需经审批（KbConfig.teamWriteApproval）：docs/a.md'))
    await expect(ctx.kbWorkbench.writeDoc(session, DOC, 'x')).rejects.toThrow(/需经审批/)
    expect(session.events.some(event => event.type === 'kb/doc-write')).toBe(false)
    mocks.writeTeamDoc.mockRejectedValueOnce(new Error('文档已被其他会话修改，请刷新后重试（docs/a.md）'))
    await expect(ctx.kbWorkbench.writeDoc(session, DOC, 'x')).rejects.toThrow(/已被其他会话修改/)
    expect(session.events.some(event => event.type === 'kb/doc-write')).toBe(false)
  })
})
