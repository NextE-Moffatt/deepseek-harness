// Milestone-4 recap tool coverage: the kb_recap schema, the scan through the
// real tool (blind spot found and recorded, kb/recap event appended, result
// rendered), the no-op path when nothing is new, the dedup across calls, the
// limit validation, and the session-root requirement.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import KbService from '../src/index.ts'
import type { CardId } from '../src/types.ts'

let workspaces: string[] = []
afterEach(async () => {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
  workspaces = []
})

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-kb-recap-tool-'))
  workspaces.push(workspace)
  return workspace
}

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(KbService, config)
  return ctx
}

/** A fake parent Agent backed by a real session with a workspace cwd. */
async function agentWithWorkspace(ctx: Context, workspace: string): Promise<Agent> {
  const session = ctx.sessions.create(SessionId('recap-tool-agent-session'), { meta: { cwd: workspace } })
  return { id: SessionId('recap-tool-agent'), session } as unknown as Agent
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`recap-call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** A past workspace session that consumed knowledge but produced no card. */
function seedBlindSpot(ctx: Context, workspace: string, id = 'past-blind'): void {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace } })
  session.append('kb/injected', {
    pack: '告警处置',
    cardIds: ['rule-20260818-001' as CardId],
    sections: [{ name: 'rule-20260818-001', text: '内容' }],
  })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '这次值班遇到新告警类型' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

describe('kb_recap tool', () => {
  it('registers with the limit parameter and renders the scan result', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'kb_recap')!
    expect((schema.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('limit')
    expect(ctx.tools.get('kb_recap')!.presentCall?.({})).toMatchObject({ title: '知识复盘扫描' })
    expect(ctx.tools.get('kb_recap')!.presentCall?.({ limit: 3 })).toMatchObject({ title: '知识复盘扫描（列出 3 条）' })
    expect(ctx.tools.get('kb_recap')!.presentResult?.({}, { content: [{ type: 'text', text: 'x' }], isError: false }))
      .toMatchObject({ title: '复盘扫描结果' })
  })

  it('lists, records, and logs a blind spot; the checkpoint dedupes a second call', async () => {
    const workspace = await makeWorkspace()
    const ctx = await setup()
    const agent = await agentWithWorkspace(ctx, workspace)
    seedBlindSpot(ctx, workspace)

    const first = await callTool(ctx, 'kb_recap', {}, agent)
    expect(first.isError).toBe(false)
    if (first.isError) throw new Error(`kb_recap failed: ${text(first)}`)
    const value = first.value as {
      scanDate: string
      total: number
      listed: number
      entries: Array<{ sessionId: string; consumed: string[]; excerpt: string }>
    }
    expect(value.total).toBe(1)
    expect(value.listed).toBe(1)
    expect(value.entries[0]!.sessionId).toBe('past-blind')
    expect(value.entries[0]!.consumed).toEqual(['rule-20260818-001'])
    expect(value.entries[0]!.excerpt).toContain('新告警类型')
    expect(text(first)).toContain('知识复盘扫描')
    expect(text(first)).toContain('past-blind')

    // The scan recorded the position into the checkpoint file.
    const checkpoint = await readFile(join(workspace, 'kb', '.kb-recap.jsonl'), 'utf8')
    expect(checkpoint).toContain('past-blind')

    // The tool appended the kb/recap event with the scan facts.
    const recapEvents = agent.session.events.filter(event => event.type === 'kb/recap')
    expect(recapEvents).toHaveLength(1)
    expect(recapEvents[0]!.data.scanned).toEqual([{ sessionId: SessionId('past-blind'), eventCount: 2 }])
    expect(recapEvents[0]!.data.blindSpots[0]!.consumed).toEqual(['rule-20260818-001'])

    // A second call finds nothing new and appends no event.
    const second = await callTool(ctx, 'kb_recap', {}, agent)
    expect(second.isError).toBe(false)
    if (!second.isError) {
      const secondValue = second.value as { total: number; listed: number; entries: unknown[] }
      expect(secondValue.total).toBe(0)
      expect(secondValue.listed).toBe(0)
      expect(secondValue.entries).toHaveLength(0)
    }
    expect(agent.session.events.filter(event => event.type === 'kb/recap')).toHaveLength(1)
    expect(text(second)).toContain('发现 0 个盲点')
  })

  it('pages through the queue with the limit argument', async () => {
    const workspace = await makeWorkspace()
    const ctx = await setup()
    const agent = await agentWithWorkspace(ctx, workspace)
    seedBlindSpot(ctx, workspace, 'blind-a')
    seedBlindSpot(ctx, workspace, 'blind-b')

    const first = await callTool(ctx, 'kb_recap', { limit: 1 }, agent)
    expect(first.isError).toBe(false)
    if (!first.isError) {
      const value = first.value as { total: number; listed: number; entries: Array<{ sessionId: string }> }
      expect(value.total).toBe(2)
      expect(value.listed).toBe(1)
      expect(value.entries).toHaveLength(1)
    }
    const second = await callTool(ctx, 'kb_recap', { limit: 1 }, agent)
    expect(second.isError).toBe(false)
    if (!second.isError) {
      const value = second.value as { total: number; entries: Array<{ sessionId: string }> }
      expect(value.total).toBe(1)
      expect(value.entries[0]!.sessionId).not.toBe((first.value as { entries: Array<{ sessionId: string }> }).entries[0]!.sessionId)
    }
  })

  it('fails loud on an invalid limit', async () => {
    const workspace = await makeWorkspace()
    const ctx = await setup()
    const agent = await agentWithWorkspace(ctx, workspace)
    // Out-of-range integers hit the tool's range check.
    for (const limit of [0, 51]) {
      const result = await callTool(ctx, 'kb_recap', { limit }, agent)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('limit must be an integer between 1 and 50')
    }
    // A non-integer is rejected by the tool runtime's schema validation.
    const fractional = await callTool(ctx, 'kb_recap', { limit: 1.5 }, agent)
    expect(fractional.isError).toBe(true)
  })

  it('requires a calling agent whose session has a workspace', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('no-cwd-session'), {})
    const agent = { id: SessionId('no-cwd-agent'), session } as unknown as Agent
    const result = await callTool(ctx, 'kb_recap', {}, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('workspace')
  })
})
