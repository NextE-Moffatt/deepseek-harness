// kb-skills coverage: the three skill bodies single-source the parser
// constants, the registration mounts the skills on a skills service and
// unregisters them on fiber disposal, and a context without the service logs
// one loud error and skips.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import KbService from '../src/index.ts'
import {
  CARD_WRITING_SKILL, PACK_BUILDING_SKILL, RECAP_FLOW_SKILL,
  cardWritingSkillContent, packBuildingSkillContent, recapFlowSkillContent, registerKbSkills,
} from '../src/skills.ts'
import { CARD_LIBRARIES, CARD_STATUSES, CARD_TIERS, CARD_TYPES } from '../src/card.ts'

let contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts = []
})

async function setup(skills = true): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  // The kb service declares tools and systemPrompt as injected services; the
  // composition mounts them (as the loader does) so the constructor activates
  // synchronously.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (skills) await ctx.plugin(SkillRegistry)
  await ctx.plugin(KbService)
  return ctx
}

describe('skill content single-sourcing', () => {
  it('card writing interpolates the parser constants', () => {
    const content = cardWritingSkillContent()
    for (const type of CARD_TYPES) expect(content).toContain(type)
    for (const tier of CARD_TIERS) expect(content).toContain(tier)
    for (const status of CARD_STATUSES) expect(content).toContain(status)
    for (const library of CARD_LIBRARIES) expect(content).toContain(library)
    expect(content).toContain('适用条件')
    expect(content).toContain('应做 / 不应做')
  })

  it('recap flow names the real tools and the blind-spot rule', () => {
    const content = recapFlowSkillContent()
    expect(content).toContain('kb_recap')
    expect(content).toContain('kb_write')
    expect(content).toContain('kb_gate_check')
    expect(content).toContain('kb_team_promote')
    expect(content).toContain('kb_review')
    expect(content).toContain('P2')
    expect(content).toContain('敢于不沉淀')
  })

  it('pack building names the filter fields and interpolates the enums', () => {
    const content = packBuildingSkillContent()
    for (const field of ['name', 'tags', 'tier', 'library', 'status', 'limit']) {
      expect(content).toContain(field)
    }
    for (const tier of CARD_TIERS) expect(content).toContain(tier)
    for (const library of CARD_LIBRARIES) expect(content).toContain(library)
  })
})

describe('registerKbSkills', () => {
  it('registers the three methodology skills and unregisters them on disposal', async () => {
    const ctx = await setup()
    const summaries = await ctx.skills.list()
    expect(summaries.map(summary => summary.name)).toEqual(
      [CARD_WRITING_SKILL, PACK_BUILDING_SKILL, RECAP_FLOW_SKILL].sort(),
    )
    const writing = await ctx.skills.get(CARD_WRITING_SKILL)
    expect(writing).toBeDefined()
    expect(writing!.content).toContain('检查清单')
    const flow = await ctx.skills.get(RECAP_FLOW_SKILL)
    expect(flow!.content).toContain('kb_recap')
    const packing = await ctx.skills.get(PACK_BUILDING_SKILL)
    expect(packing!.content).toContain('tags')

    // Disposing the mounting context removes the runtime skills (registry
    // contributions prove disposal).
    await ctx.fiber.dispose()
    contexts = contexts.filter(candidate => candidate !== ctx)
    const after = await new SkillRegistry(new Context()).list()
    expect(after.some(summary => summary.name === CARD_WRITING_SKILL)).toBe(false)
  })

  it('logs one loud error and skips without a skills service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const errors: unknown[][] = []
    ctx.logger.error = ((...args: unknown[]) => { errors.push(args) }) as never
    registerKbSkills(ctx)
    registerKbSkills(ctx)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]![0])).toContain('no skills service is mounted')
  })
})
