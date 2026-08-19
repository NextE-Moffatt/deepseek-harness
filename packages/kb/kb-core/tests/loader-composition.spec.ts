// Real-composition acceptance chain: boots a test-only cordis.yml through the
// real Loader with kb-core mounted, then drives the acceptance path in a real
// workspace directory — kb_write a draft card → kb_search finds it → kb_promote
// flips the state → the kb/* events replay from the session log. The injection
// block drives the agent/session-start extension point on the same composition
// and asserts the kb/injected event, the kb:pack fold, and log replay.
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as KbCore from '@deepseek-ai/dsh-kb-core'

const execFileAsync = promisify(execFile)

let root: string | undefined
let workspace: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, workspace]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  root = undefined
  workspace = undefined
})

/** A fake parent Agent backed by a real store-entered session whose cwd is the workspace. */
function agent(ctx: Context, cwd?: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('kb-loader-agent')
  // Entered through the store so session/event dispatches reach global
  // listeners (the telemetry projection consumes them).
  const session = ctx.sessions.create(id, { meta: cwd === undefined ? {} : { cwd } })
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function boot(
  configLines: readonly string[] = [],
  extra: { rows?: readonly string[]; modules?: ReadonlyArray<readonly [string, unknown]> } = {},
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-kb-loader-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-workspace-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    ...extra.rows ?? [],
    "- name: '@deepseek-ai/dsh-kb-core'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-kb-core', KbCore],
    ...extra.modules ?? [],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('kb-core real composition', () => {
  it('acceptance chain: kb_write → kb_search → kb_promote, replayable from the log', async () => {
    const ctx = await boot()
    const caller = agent(ctx, workspace)

    const write = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-write'),
      name: 'kb_write',
      arguments: {
        tier: 'P2',
        type: 'rule',
        title: '告警处置标准',
        适用条件: '值班收到告警',
        核心结论: '先确认影响面。',
        应做: ['确认影响面'],
        不应做: ['直接重启'],
        责任人: '张三',
        标签: ['告警'],
      },
      agent: caller,
    })
    expect(write.isError).toBe(false)
    if (write.isError) throw new Error('kb_write failed in composition')
    const cardId = (write.value as { id: string }).id
    expect(cardId).toMatch(/^rule-\d{8}-001$/)
    expect(await readFile(join(workspace!, 'kb/cards/P2', `${cardId}.md`), 'utf8')).toContain('状态: draft')

    const search = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-search'),
      name: 'kb_search',
      arguments: { query: '告警' },
      agent: caller,
    })
    expect(search.isError).toBe(false)
    if (search.isError) throw new Error('kb_search failed in composition')
    const found = search.value as { mode: string; total: number; hits: { id: string }[] }
    expect(found.mode).toBe('fts')
    expect(found.total).toBe(1)
    expect(found.hits[0]?.id).toBe(cardId)

    const promote = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-promote'),
      name: 'kb_promote',
      arguments: { id: cardId, target: 'pending', evidence: 'MR#42' },
      agent: caller,
    })
    expect(promote.isError).toBe(false)
    if (promote.isError) throw new Error('kb_promote failed in composition')
    expect(promote.value).toMatchObject({ id: cardId, from: 'draft', to: 'pending' })
    expect(await readFile(join(workspace!, 'kb/cards/P2', `${cardId}.md`), 'utf8')).toContain('状态: pending')

    // Log replay: a fresh session seeded with the caller's log reconstructs the
    // full acceptance chain — the write, the search call, and the promotion.
    const log = caller.session.events.map(event => ({ type: event.type, data: event.data }))
    expect(log.filter(event => event.type === 'kb/write')).toHaveLength(1)
    expect(log.filter(event => event.type === 'kb/promote')).toHaveLength(1)
    const replayed = Session.create(SessionId('replay'), caller.session.events)
    const replayKbEvents = replayed.events
      .filter(event => event.type === 'kb/write' || event.type === 'kb/promote')
      .map(event => ({ type: event.type, data: event.data }))
    expect(replayKbEvents).toEqual(log.filter(event => event.type === 'kb/write' || event.type === 'kb/promote'))
    expect(replayed.events.some(event =>
      event.type === 'kb/promote' && event.data.id === cardId && event.data.from === 'draft' && event.data.to === 'pending',
    )).toBe(true)
    expect(resultText(write)).toContain(cardId)
  })

  it('mounts with an explicit config block from cordis.yml', async () => {
    const ctx = await boot([
      '    cardsPath: kb/my-cards',
      '    indexPath: kb/my-index.sqlite',
      '    cardTtlDays: 7',
    ])
    expect(ctx.kb.config).toEqual({
      cardsPath: 'kb/my-cards',
      indexPath: 'kb/my-index.sqlite',
      cardTtlDays: 7,
      heatPath: 'kb/.kb-heat.jsonl',
      freshnessWarningDays: 14,
      freshnessIntervalDays: 0,
      teamWriteApproval: true,
      recapPath: 'kb/.kb-recap.jsonl',
      recapIntervalDays: 0,
      packs: [],
    })
    const description = ctx.tools.schemas().find(schema => schema.name === 'kb_write')!.description
    expect(description).toContain('7')
  })
})

describe('kb injection composition', () => {
  const PACK_CONFIG = [
    '    packs:',
    '      - name: 告警处置',
    '        tags:',
    '          - 告警',
    '      - name: 巡检',
    '        tags:',
    '          - 巡检',
    '        limit: 1',
  ]

  it('acceptance chain: pack injection at session start reaches the fold and replays from the log', async () => {
    const ctx = await boot(PACK_CONFIG)
    expect(ctx.kb.config.packs).toEqual([
      { name: '告警处置', tags: ['告警'] },
      { name: '巡检', tags: ['巡检'], limit: 1 },
    ])
    const caller = agent(ctx, workspace)

    // Seed the library with two tagged draft cards through the real tool.
    const writtenIds: string[] = []
    for (const [tier, type, title, tag] of [
      ['P2', 'rule', '告警处置标准', '告警'],
      ['P2', 'case', '巡检案例', '巡检'],
    ] as const) {
      const write = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`loader-inject-write-${tag}`),
        name: 'kb_write',
        arguments: {
          tier, type, title,
          适用条件: `值班收到${tag}`,
          核心结论: `按${tag}流程处置。`,
          应做: ['确认影响面'],
          不应做: ['直接重启'],
          责任人: '张三',
          标签: [tag],
        },
        agent: caller,
      })
      expect(write.isError).toBe(false)
      if (!write.isError) writtenIds.push((write.value as { id: string }).id)
    }
    // An unparseable card file is skipped and reported, not fatal.
    await writeFile(join(workspace!, 'kb/cards/P2', 'broken.md'), 'not a card', 'utf8')

    // The session-start extension point triggers the synchronous injection.
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    const injected = caller.session.events.filter(event => event.type === 'kb/injected')
    expect(injected).toHaveLength(2)
    const alertPack = injected.find(event => event.data.pack === '告警处置')!
    expect(alertPack.data.cardIds).toHaveLength(1)
    expect(alertPack.data.sections[0]!.name).toBe(writtenIds[0])
    expect(alertPack.data.sections[0]!.text).toContain('标题：告警处置标准')
    expect(alertPack.data.sections[0]!.text).toContain('应做：确认影响面')
    const patrolPack = injected.find(event => event.data.pack === '巡检')!
    expect(patrolPack.data.cardIds).toHaveLength(1)
    expect(patrolPack.data.cardIds[0]).toBe(writtenIds[1])

    // The kb:pack section folds the log and carries the card content.
    const fold = KbCore.foldInjected(caller.session.events)
    expect(fold).toContain('## 知识包：告警处置')
    expect(fold).toContain(`### ${writtenIds[0]}`)
    expect(fold).toContain('## 知识包：巡检')

    // A fresh session seeded with the log reproduces the fold byte-identically.
    const replayed = Session.create(SessionId('replay-injected'), caller.session.events)
    expect(KbCore.foldInjected(replayed.events)).toBe(fold)
    expect(replayed.events.some(event =>
      event.type === 'kb/injected' && event.data.pack === '告警处置'
      && event.data.cardIds.includes(writtenIds[0] as never),
    )).toBe(true)

    // A re-emitted session-start does not double-inject (once per session per pack).
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'resume' })
    expect(caller.session.events.filter(event => event.type === 'kb/injected')).toHaveLength(2)
  })

  it('skips injection when the session has no workspace cwd', async () => {
    const ctx = await boot(PACK_CONFIG)
    const caller = agent(ctx)
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    expect(caller.session.events.filter(event => event.type === 'kb/injected')).toHaveLength(0)
  })

  it('injects nothing when no packs are configured', async () => {
    const ctx = await boot()
    const caller = agent(ctx, workspace)
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    expect(caller.session.events.filter(event => event.type === 'kb/injected')).toHaveLength(0)
  })

  it('skips a pack that matches no cards', async () => {
    const ctx = await boot([
      '    packs:',
      '      - name: 无人订阅',
      '        tags:',
      '          - 不存在',
    ])
    const caller = agent(ctx, workspace)
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    expect(caller.session.events.filter(event => event.type === 'kb/injected')).toHaveLength(0)
  })

  it('logs and continues when the library cannot be read', async () => {
    const ctx = await boot(PACK_CONFIG)
    const caller = agent(ctx, workspace)
    await mkdir(join(workspace!, 'kb/cards/P2'), { recursive: true })
    await chmod(join(workspace!, 'kb/cards/P2'), 0o000)
    try {
      emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    } finally {
      await chmod(join(workspace!, 'kb/cards/P2'), 0o700)
    }
    expect(caller.session.events.filter(event => event.type === 'kb/injected')).toHaveLength(0)
  })

  it('renders the kb:pack section only for agent assemblies', async () => {
    const ctx = await boot(PACK_CONFIG)
    const caller = agent(ctx, workspace)
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })

    const withoutAgent = await ctx.systemPrompt.assemble({})
    const sections = withoutAgent.sections.filter(section => section.name === 'kb:pack')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.text).toBe('')
  })
})

/**
 * Milestone-3 acceptance composition: a real workspace plus a real team git
 * repository, with the approval service and the jobs registry mounted. The
 * chain — gate check → team promotion → review → commit → team-pack injection
 * → heat projection → freshness review (tool and scheduled job) — runs through
 * the real Loader, and the session log alone reconstructs it.
 */
describe('kb milestone-3 team composition', () => {
  const TEAM_PACKS = [
    '    packs:',
    '      - name: 团队告警',
    '        tags:',
    '          - 告警',
    '        library:',
    '          - team',
  ]

  /** An approval service that grants every team write. */
  class AllowAllApproval extends Service {
    constructor(ctx: Context) {
      super(ctx, 'approval')
    }

    async request(): Promise<ApprovalOutcome> {
      return 'allowed-once'
    }
  }

  async function makeTeamRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'dsh-kb-team-composition-'))
    await execFileAsync('git', ['init', '-q', repo])
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'kb-test@example.com'])
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'kb test'])
    return repo
  }

  async function teamBoot(extraConfig: readonly string[] = []): Promise<{ ctx: Context; teamRepo: string }> {
    const teamRepo = await makeTeamRepo()
    const ctx = await boot([
      `    teamRepoPath: ${teamRepo}`,
      ...TEAM_PACKS,
      ...extraConfig,
    ], {
      rows: [
        "- name: 'test-allow-approval'",
        "- name: '@deepseek-ai/dsh-jobs-local'",
        "- name: '@deepseek-ai/dsh-tool-jobs'",
      ],
      modules: [
        ['test-allow-approval', { default: AllowAllApproval }],
        ['@deepseek-ai/dsh-jobs-local', JobsLocal],
        ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
      ],
    })
    return { ctx, teamRepo }
  }

  it('dual gate → team pack injection → telemetry → freshness review, replayable from the log', async () => {
    const { ctx, teamRepo } = await teamBoot(['    freshnessIntervalDays: 7'])
    const caller = agent(ctx, workspace)

    // 1. A personal draft plus an expired draft the freshness scan will flag.
    const write = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-write'),
      name: 'kb_write',
      arguments: {
        tier: 'P2', type: 'rule', title: '告警处置标准',
        适用条件: '值班收到告警', 核心结论: '先确认影响面。',
        应做: ['确认影响面'], 不应做: ['直接重启'],
        来源: 'MR#42', 责任人: '张三', 标签: ['告警'],
      },
      agent: caller,
    })
    expect(write.isError).toBe(false)
    if (write.isError) throw new Error('m3 kb_write failed')
    const cardId = (write.value as { id: string }).id
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-write-stale'),
      name: 'kb_write',
      arguments: {
        tier: 'P2', type: 'rule', title: '过期草稿',
        适用条件: '历史场景', 核心结论: '已过期。',
        应做: ['确认'], 不应做: ['忽略'],
        责任人: '张三', 有效期: '2020-01-01',
      },
      agent: caller,
    })

    // 2. First gate: evidence → PASS.
    const gate = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-gate'),
      name: 'kb_gate_check',
      arguments: { id: cardId, evidence: ['上线 MR#42', '事件单#88 关闭'] },
      agent: caller,
    })
    expect(gate.isError).toBe(false)
    if (!gate.isError) expect((gate.value as { verdict: string }).verdict).toBe('PASS')

    // 3. Team promotion through the approval gate: the card enters the team
    // library as pending, the personal file moves, both events append.
    const promote = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-promote'),
      name: 'kb_team_promote',
      arguments: { id: cardId, evidence: ['上线 MR#42'] },
      agent: caller,
    })
    expect(promote.isError).toBe(false)
    if (promote.isError) throw new Error('m3 promotion denied')
    const teamFile = join(teamRepo, 'cards', `${cardId}.md`)
    expect(await readFile(teamFile, 'utf8')).toContain('状态: pending')
    await expect(readFile(join(workspace!, 'kb/cards/P2', `${cardId}.md`), 'utf8')).rejects.toThrow()

    // 4. Second gate: human review approves → ready (the reference pool).
    const review = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-review'),
      name: 'kb_review',
      arguments: { id: cardId, approved: true, note: '复核通过' },
      agent: caller,
    })
    expect(review.isError).toBe(false)
    if (!review.isError) expect(review.value).toMatchObject({ status: 'ready', changed: true })
    expect(await readFile(teamFile, 'utf8')).toContain('状态: ready')

    // 5. The draft → review → commit flow: status shows the change, commit
    // lands it in the repository history.
    const status = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-status'),
      name: 'kb_team_status',
      arguments: {},
      agent: caller,
    })
    expect(status.isError).toBe(false)
    if (!status.isError) expect((status.value as { clean: boolean }).clean).toBe(false)
    const commit = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-commit'),
      name: 'kb_team_commit',
      arguments: { message: `晋升 ${cardId}` },
      agent: caller,
    })
    expect(commit.isError).toBe(false)
    if (commit.isError) throw new Error('m3 commit failed')
    const { stdout: log } = await execFileAsync('git', ['-C', teamRepo, 'log', '-n 1', '--oneline'])
    expect(log).toContain(`晋升 ${cardId}`)

    // 6. Session start: the team pack injects the reference-pool card through
    // the milestone-2 mechanism; kb/injected carries the team card id.
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })
    const injected = caller.session.events.filter(event => event.type === 'kb/injected')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.data.cardIds).toContain(cardId)
    const fold = KbCore.foldInjected(caller.session.events)
    expect(fold).toContain('## 知识包：团队告警')
    expect(fold).toContain(`### ${cardId}`)

    // 7. Telemetry: the ledger projects which card this session consumed
    // (the projection append is asynchronous, so settle it before reading).
    await new Promise(resolve => setTimeout(resolve, 50))
    const heat = await ctx.kb.heat(workspace!)
    const row = heat.find(entry => entry.cardId === cardId)
    expect(row).toBeDefined()
    expect(row!.sessions).toContain(caller.id)
    expect(row!.packs).toContain('团队告警')

    // 8. Freshness: the on-demand scan flags the expired draft, and the
    // scheduled job (freshnessIntervalDays) produces the same review list.
    const scan = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-freshness'),
      name: 'kb_freshness',
      arguments: {},
      agent: caller,
    })
    expect(scan.isError).toBe(false)
    if (!scan.isError) {
      const value = scan.value as { total: number; overdue: Array<{ id: string; recommend: string }> }
      expect(value.total).toBe(1)
      expect(value.overdue[0]!.recommend).toBe('archive-candidate')
    }
    const jobs = ctx.jobs.list(caller)
    expect(jobs.some(job => job.kind === 'kb-freshness')).toBe(true)
    const freshnessJob = jobs.find(job => job.kind === 'kb-freshness')!
    const jobRead = ctx.jobs.read(freshnessJob.id, caller)
    expect(jobRead.text).toContain('知识保鲜扫描')
    expect(jobRead.text).toContain('[已过期]')

    // 9. Replay: a fresh session seeded with the log reconstructs the whole
    // chain — the write, the gate-1 promotion with its move, the review, and
    // the team-pack injection.
    const replayed = Session.create(SessionId('m3-replay'), caller.session.events)
    const kbEvents = replayed.events.filter(event =>
      event.type === 'kb/write' || event.type === 'kb/promote' || event.type === 'kb/team-join' || event.type === 'kb/injected',
    )
    expect(kbEvents.some(event =>
      event.type === 'kb/team-join' && event.data.id === cardId && event.data.status === 'pending',
    )).toBe(true)
    expect(kbEvents.some(event =>
      event.type === 'kb/promote' && event.data.id === cardId && event.data.to === 'ready',
    )).toBe(true)
    expect(kbEvents.some(event =>
      event.type === 'kb/injected' && (event.data.cardIds as string[]).includes(cardId),
    )).toBe(true)
    expect(KbCore.foldInjected(replayed.events)).toBe(fold)
  })

  it('denies team writes when the approval service rejects and the personal side stays intact', async () => {
    const teamRepo = await makeTeamRepo()
    class DenyAllApproval extends Service {
      constructor(ctx: Context) {
        super(ctx, 'approval')
      }

      async request(): Promise<ApprovalOutcome> {
        return 'rejected'
      }
    }
    const denyCtx = await boot([
      `    teamRepoPath: ${teamRepo}`,
      ...TEAM_PACKS,
    ], {
      rows: [
        "- name: 'test-deny-approval'",
        "- name: '@deepseek-ai/dsh-jobs-local'",
        "- name: '@deepseek-ai/dsh-tool-jobs'",
      ],
      modules: [
        ['test-deny-approval', { default: DenyAllApproval }],
        ['@deepseek-ai/dsh-jobs-local', JobsLocal],
        ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
      ],
    })
    const denyCaller = agent(denyCtx, workspace)
    const write = await denyCtx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-deny-write'),
      name: 'kb_write',
      arguments: {
        tier: 'P2', type: 'rule', title: '告警处置标准',
        适用条件: '值班收到告警', 核心结论: '先确认影响面。',
        应做: ['确认影响面'], 不应做: ['直接重启'],
        来源: 'MR#42', 责任人: '张三', 标签: ['告警'],
      },
      agent: denyCaller,
    })
    expect(write.isError).toBe(false)
    if (write.isError) throw new Error('m3 deny kb_write failed')
    const cardId = (write.value as { id: string }).id
    const promote = await denyCtx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m3-deny-promote'),
      name: 'kb_team_promote',
      arguments: { id: cardId, evidence: ['上线'] },
      agent: denyCaller,
    })
    expect(promote.isError).toBe(true)
    expect(promote.isError ? promote.content.filter(b => b.type === 'text').map(b => b.text).join('') : '')
      .toContain('rejected')
    // The personal draft survives the denied promotion.
    expect(await readFile(join(workspace!, 'kb/cards/P2', `${cardId}.md`), 'utf8')).toContain('状态: draft')
    await denyCtx.fiber.dispose()
  })
})

/**
 * Milestone-4 acceptance composition: a real workspace with a past
 * blind-spot session, the recap scheduler, the skills registry, and the
 * approval + jobs services mounted. The chain — recap scan (tool and
 * scheduled job) → distillation through kb_write → the milestone-3 dual gate
 * on the new draft — runs through the real Loader, and the session log alone
 * reconstructs it.
 */
describe('kb milestone-4 recap and skills composition', () => {
  /** An approval service that grants every team write. */
  class AllowAllApproval extends Service {
    constructor(ctx: Context) {
      super(ctx, 'approval')
    }

    async request(): Promise<ApprovalOutcome> {
      return 'allowed-once'
    }
  }

  async function makeTeamRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'dsh-kb-team-m4-'))
    await execFileAsync('git', ['init', '-q', repo])
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'kb-test@example.com'])
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'kb test'])
    return repo
  }

  async function recapBoot(): Promise<{ ctx: Context; teamRepo: string }> {
    const teamRepo = await makeTeamRepo()
    const ctx = await boot([
      `    teamRepoPath: ${teamRepo}`,
      '    recapIntervalDays: 7',
    ], {
      rows: [
        "- name: 'test-allow-approval'",
        "- name: '@deepseek-ai/dsh-jobs-local'",
        "- name: '@deepseek-ai/dsh-tool-jobs'",
        "- name: '@deepseek-ai/dsh-skill'",
      ],
      modules: [
        ['test-allow-approval', { default: AllowAllApproval }],
        ['@deepseek-ai/dsh-jobs-local', JobsLocal],
        ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
        ['@deepseek-ai/dsh-skill', { default: SkillRegistry }],
      ],
    })
    return { ctx, teamRepo }
  }

  /** A past workspace session that consumed knowledge but produced no card. */
  function seedBlindSpot(ctx: Context, id: string, text: string): void {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace! } })
    session.append('kb/injected', {
      pack: '告警处置',
      cardIds: ['rule-20260818-100' as never],
      sections: [{ name: 'rule-20260818-100', text: '标题：团队告警处置基线' }],
    })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }

  it('recap scan → distillation draft → dual gate, replayable from the log; the job and skills mount', async () => {
    const { ctx, teamRepo } = await recapBoot()
    const caller = agent(ctx, workspace)

    // 1. A past session already consumed knowledge without producing: seed it
    // before session start, so the recap job's immediate scan surfaces it.
    seedBlindSpot(ctx, 'm4-blind-a', '值班遇到告警 A，处置后没有沉淀。')
    emitAgentEvent(ctx, caller, 'agent/session-start', { source: 'startup' })

    // 2. A second blind spot appears after the job's tick: the recap tool
    // surfaces it (the queue dedupes per session, so both get listed once).
    seedBlindSpot(ctx, 'm4-blind-b', '值班遇到新告警类型，按基线处置后追加了防误报步骤。')
    await new Promise(resolve => setTimeout(resolve, 50))
    const scan = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m4-recap'),
      name: 'kb_recap',
      arguments: {},
      agent: caller,
    })
    expect(scan.isError).toBe(false)
    if (scan.isError) throw new Error('m4 kb_recap failed')
    const scanValue = scan.value as { total: number; listed: number; entries: Array<{ sessionId: string; excerpt: string }> }
    expect(scanValue.total).toBe(1)
    expect(scanValue.listed).toBe(1)
    expect(scanValue.entries[0]!.sessionId).toBe('m4-blind-b')
    expect(scanValue.entries[0]!.excerpt).toContain('防误报')
    expect(await readFile(join(workspace!, 'kb/.kb-recap.jsonl'), 'utf8')).toContain('m4-blind-a')
    expect(await readFile(join(workspace!, 'kb/.kb-recap.jsonl'), 'utf8')).toContain('m4-blind-b')
    // The job's immediate tick and the tool call each logged their scan.
    const recapEvents = caller.session.events.filter(event => event.type === 'kb/recap')
    expect(recapEvents).toHaveLength(2)
    expect(recapEvents[0]!.data.blindSpots[0]!.sessionId).toBe('m4-blind-a')
    expect(recapEvents[1]!.data.blindSpots[0]!.sessionId).toBe('m4-blind-b')
    expect(recapEvents[1]!.data.blindSpots[0]!.consumed).toEqual(['rule-20260818-100'])

    // 3. A rescan lists nothing: the positions dedupe the queue.
    const rescan = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m4-recap-again'),
      name: 'kb_recap',
      arguments: {},
      agent: caller,
    })
    expect(rescan.isError).toBe(false)
    if (!rescan.isError) expect((rescan.value as { total: number }).total).toBe(0)

    // 4. The scheduled recap job exists and its buffered output carries the
    // blind spot its immediate scan surfaced.
    const jobs = ctx.jobs.list(caller)
    const recapJob = jobs.find(job => job.kind === 'kb-recap')
    expect(recapJob).toBeDefined()
    const jobRead = ctx.jobs.read(recapJob!.id, caller)
    expect(jobRead.text).toContain('知识复盘扫描')
    expect(jobRead.text).toContain('m4-blind-a')

    // 5. The model distills a draft card from the recap material into P2.
    const write = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m4-write'),
      name: 'kb_write',
      arguments: {
        tier: 'P2', type: 'rule', title: '新告警防误报步骤',
        适用条件: '值班收到同类新告警', 核心结论: '按基线处置后追加防误报步骤。',
        应做: ['追加防误报步骤'], 不应做: ['跳过基线'],
        来源: 'session:m4-blind 复盘', 责任人: '张三', 标签: ['告警'],
      },
      agent: caller,
    })
    expect(write.isError).toBe(false)
    if (write.isError) throw new Error('m4 distillation kb_write failed')
    const cardId = (write.value as { id: string }).id

    // 6. The new draft walks the milestone-3 dual gate: check → promote → review.
    const gate = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m4-gate'),
      name: 'kb_gate_check',
      arguments: { id: cardId, evidence: ['复盘确认', '复用 2 次'] },
      agent: caller,
    })
    expect(gate.isError).toBe(false)
    if (!gate.isError) expect((gate.value as { verdict: string }).verdict).toBe('PASS')
    const promote = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m4-promote'),
      name: 'kb_team_promote',
      arguments: { id: cardId, evidence: ['复盘确认'] },
      agent: caller,
    })
    expect(promote.isError).toBe(false)
    if (promote.isError) throw new Error('m4 promotion denied')
    expect(await readFile(join(teamRepo, 'cards', `${cardId}.md`), 'utf8')).toContain('状态: pending')
    const review = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('m4-review'),
      name: 'kb_review',
      arguments: { id: cardId, approved: true, note: '复核通过' },
      agent: caller,
    })
    expect(review.isError).toBe(false)
    if (!review.isError) expect(review.value).toMatchObject({ status: 'ready', changed: true })

    // 7. The methodology skills are loadable by the model.
    const summaries = await ctx.skills.list()
    expect(summaries.some(summary => summary.name === 'kb-card-writing')).toBe(true)
    const writing = await ctx.skills.get('kb-card-writing')
    expect(writing).toBeDefined()
    expect(writing!.content).toContain('检查清单')

    // 8. Replay: a fresh session seeded with the log reconstructs the chain.
    const replayed = Session.create(SessionId('m4-replay'), caller.session.events)
    const replayRecaps = replayed.events.filter(event => event.type === 'kb/recap')
    expect(replayRecaps).toHaveLength(2)
    expect(replayRecaps[1]!.data.scanned).toEqual([{ sessionId: SessionId('m4-blind-b'), eventCount: 2 }])
    expect(replayRecaps[0]!.data.scanned).toEqual([{ sessionId: SessionId('m4-blind-a'), eventCount: 2 }])
    expect(replayed.events.some(event =>
      event.type === 'kb/write' && event.data.id === cardId,
    )).toBe(true)
    expect(replayed.events.some(event =>
      event.type === 'kb/promote' && event.data.id === cardId && event.data.to === 'ready',
    )).toBe(true)
  })
})
