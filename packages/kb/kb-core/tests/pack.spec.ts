// Pure knowledge-pack logic: config resolution, card selection, section
// rendering, and the kb:pack log fold.
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseCard } from '@deepseek-ai/dsh-kb-core'
import type { CardFileInfo } from '@deepseek-ai/dsh-kb-core'
import {
  foldInjected, hasInjectedPack, renderCardSection, resolvePacks, selectPackCards,
} from '@deepseek-ai/dsh-kb-core'
import type { Card, CardId } from '@deepseek-ai/dsh-kb-core'

/** A minimal valid card for selection and rendering tests. */
function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'rule-20250818-001' as CardId,
    type: 'rule',
    title: '告警处置标准',
    库: 'personal',
    状态: 'draft',
    适用条件: '值班收到告警',
    核心结论: '先确认影响面再处置。',
    应做: ['确认影响面'],
    不应做: ['直接重启'],
    责任人: '张三',
    有效期: '2026-12-31',
    标签: ['告警', '处置'],
    ...overrides,
  }
}

/** One library entry for a card in the given tier. */
function entry(cardValue: Card, tier: 'P0' | 'P1' | 'P2' | 'P3' = 'P2'): CardFileInfo {
  return { card: cardValue, tier, path: `/tmp/kb/cards/${tier}/${cardValue.id}.md`, mtime: 1, size: 1 }
}

/** A logged kb/injected event with the given pack and sections. */
function injectedEvent(pack: string, sections: { name: string; text: string }[]): SessionEvent {
  return {
    type: 'kb/injected',
    seq: 1,
    time: 1,
    data: { pack, cardIds: sections.map(section => section.name) as CardId[], sections },
  } as unknown as SessionEvent
}

describe('resolvePacks', () => {
  it('resolves an absent field to no packs', () => {
    expect(resolvePacks(undefined)).toEqual([])
  })

  it('resolves a minimal pack with defaults', () => {
    expect(resolvePacks([{ name: '告警处置' }])).toEqual([{ name: '告警处置' }])
  })

  it('resolves every filter field and drops duplicate tags', () => {
    expect(resolvePacks([{
      name: '告警处置',
      tags: ['告警', '告警'],
      tier: ['P2', 'P3'],
      status: ['ready'],
      limit: 5,
    }])).toEqual([{ name: '告警处置', tags: ['告警'], tier: ['P2', 'P3'], status: ['ready'], limit: 5 }])
  })

  it('fails loud when packs is not an array', () => {
    expect(() => resolvePacks('告警处置')).toThrow('KbConfig.packs must be an array of pack objects')
  })

  it('fails loud when a pack is not an object', () => {
    expect(() => resolvePacks([42])).toThrow('packs[0] must be an object')
    expect(() => resolvePacks([[{ name: 'x' }]])).toThrow('packs[0] must be an object')
  })

  it('fails loud when a filter field is not an array', () => {
    expect(() => resolvePacks([{ name: 'x', tags: '告警' }]))
      .toThrow('tags must be an array of non-empty strings')
  })

  it('fails loud on duplicate pack names', () => {
    expect(() => resolvePacks([{ name: '告警处置' }, { name: '告警处置' }]))
      .toThrow('packs names must be unique')
  })

  it('fails loud on a missing or blank pack name', () => {
    expect(() => resolvePacks([{}])).toThrow('name must be a non-empty string')
    expect(() => resolvePacks([{ name: '  ' }])).toThrow('name must be a non-empty string')
  })

  it('fails loud on unknown pack keys', () => {
    expect(() => resolvePacks([{ name: '告警处置', scene: ['告警'] }]))
      .toThrow('has unknown key(s) scene')
  })

  it('fails loud on invalid enum members', () => {
    expect(() => resolvePacks([{ name: 'x', tier: ['P5'] }])).toThrow('tier must contain only P0, P1, P2, P3')
    expect(() => resolvePacks([{ name: 'x', status: ['live'] }]))
      .toThrow('status must contain only draft, pending, ready, archived, revived')
    expect(() => resolvePacks([{ name: 'x', tier: [] }])).toThrow('tier must be a non-empty array')
  })

  it('fails loud on a non-positive or non-integer limit', () => {
    expect(() => resolvePacks([{ name: 'x', limit: 0 }])).toThrow('limit must be a positive integer')
    expect(() => resolvePacks([{ name: 'x', limit: 1.5 }])).toThrow('limit must be a positive integer')
  })

  it('fails loud on blank tag strings', () => {
    expect(() => resolvePacks([{ name: 'x', tags: ['告警', ''] }])).toThrow('tags item 1 must be a non-empty string')
  })
})

describe('selectPackCards', () => {
  const a = entry(card({ id: 'case-20250818-001' as CardId, 标签: ['告警'] }))
  const b = entry(card({ id: 'rule-20250818-002' as CardId, 标签: ['告警', '处置'] }))
  const c = entry(card({ id: 'rule-20250818-003' as CardId, 标签: ['巡检'] }), 'P3')
  const archived = entry(card({ id: 'rule-20250818-004' as CardId, 状态: 'archived', 标签: ['告警'] }))

  it('selects every non-archived card when the pack has no filters', () => {
    const selected = selectPackCards([a, b, c, archived], { name: '全部' })
    expect(selected.map(entryValue => entryValue.card.id)).toEqual([
      'case-20250818-001', 'rule-20250818-002', 'rule-20250818-003',
    ])
  })

  it('filters by tags (every listed tag must be present)', () => {
    const selected = selectPackCards([a, b, c], { name: '告警处置', tags: ['告警', '处置'] })
    expect(selected.map(entryValue => entryValue.card.id)).toEqual(['rule-20250818-002'])
  })

  it('filters by tier allowlist', () => {
    const selected = selectPackCards([a, c], { name: '经验', tier: ['P3'] })
    expect(selected.map(entryValue => entryValue.card.id)).toEqual(['rule-20250818-003'])
  })

  it('filters by status allowlist, overriding the archived default', () => {
    const selected = selectPackCards([a, archived], { name: '历史', status: ['archived'] })
    expect(selected.map(entryValue => entryValue.card.id)).toEqual(['rule-20250818-004'])
    expect(selectPackCards([a, archived], { name: '活跃', status: ['draft', 'ready'] })
      .map(entryValue => entryValue.card.id)).toEqual(['case-20250818-001'])
  })

  it('caps at the pack limit after sorting by id', () => {
    const selected = selectPackCards([b, a], { name: '告警处置', limit: 1 })
    expect(selected.map(entryValue => entryValue.card.id)).toEqual(['case-20250818-001'])
  })

  it('returns no cards when nothing matches', () => {
    expect(selectPackCards([a, b], { name: '巡检', tags: ['巡检'] })).toEqual([])
  })
})

describe('renderCardSection', () => {
  it('renders the knowledge fields, skipping governance metadata', () => {
    expect(renderCardSection(card())).toEqual({
      name: 'rule-20250818-001',
      text: '标题：告警处置标准\n适用条件：值班收到告警\n核心结论：先确认影响面再处置。\n应做：确认影响面\n不应做：直接重启',
    })
  })

  it('includes the optional 反例 when present', () => {
    const section = renderCardSection(card({ 反例: '直接重启导致二次故障' }))
    expect(section.text).toContain('反例：直接重启导致二次故障')
  })

  it('renders list items joined by 分号', () => {
    const section = renderCardSection(card({ 应做: ['确认影响面', '通知负责人'] }))
    expect(section.text).toContain('应做：确认影响面；通知负责人')
  })
})

describe('foldInjected', () => {
  it('folds an empty log to the empty string', () => {
    expect(foldInjected([])).toBe('')
  })

  it('ignores unrelated events', () => {
    const unrelated = { type: 'kb/write', seq: 1, time: 1, data: { id: 'rule-1' } } as unknown as SessionEvent
    expect(foldInjected([unrelated])).toBe('')
  })

  it('renders one pack with its card sections', () => {
    const event = injectedEvent('告警处置', [
      { name: 'rule-20250818-001', text: '标题：告警处置标准\n适用条件：值班收到告警' },
    ])
    expect(foldInjected([event])).toBe(
      '## 知识包：告警处置\n\n### rule-20250818-001\n标题：告警处置标准\n适用条件：值班收到告警',
    )
  })

  it('renders multiple packs and cards in log order', () => {
    const first = injectedEvent('告警处置', [{ name: 'a', text: 'A' }])
    const second = injectedEvent('巡检', [
      { name: 'b', text: 'B' },
      { name: 'c', text: 'C' },
    ])
    expect(foldInjected([first, second])).toBe(
      '## 知识包：告警处置\n\n### a\nA\n\n## 知识包：巡检\n\n### b\nB\n\n### c\nC',
    )
  })

  it('round-trips with the card parser: a real card renders and folds from the log', () => {
    const parsed = parseCard(`---
id: rule-20250818-001
type: rule
title: 告警处置标准
库: personal
状态: draft
适用条件: 值班收到告警
责任人: 张三
有效期: 2026-12-31
标签:
  - 告警
---

## 核心结论

先确认影响面再处置。

## 应做

- 确认影响面

## 不应做

- 直接重启
`, '/tmp/card.md')
    const section = renderCardSection(parsed)
    expect(foldInjected([injectedEvent('告警处置', [section])])).toContain('标题：告警处置标准')
    expect(foldInjected([injectedEvent('告警处置', [section])])).toContain('应做：确认影响面')
  })
})

describe('hasInjectedPack', () => {
  it('is false for a log without the pack', () => {
    expect(hasInjectedPack([], '告警处置')).toBe(false)
    expect(hasInjectedPack([injectedEvent('巡检', [{ name: 'a', text: 'A' }])], '告警处置')).toBe(false)
  })

  it('is true once the pack is injected', () => {
    expect(hasInjectedPack([injectedEvent('告警处置', [{ name: 'a', text: 'A' }])], '告警处置')).toBe(true)
  })
})
