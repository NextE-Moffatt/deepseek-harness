import { describe, expect, it } from 'vitest'
import {
  CARD_LIBRARIES, CARD_STATUSES, CARD_TIERS, CARD_TYPES,
  isCardLibrary, isCardStatus, isCardTier, isCardType, isValidDateString,
  parseCard, serializeCard,
} from '../src/card.ts'
import type { Card } from '../src/types.ts'

const TEMPLATE = `---
id: rule-20250818-001
type: rule
title: 处置标准：XX 类事件怎么办
库: personal
状态: draft
适用条件: 值班时收到 XX 类告警，需要统一处置口径
来源: MR#123
责任人: 张三
有效期: 2025-11-16
标签: [告警处置, 值班]
---

## 核心结论
XX 类事件按统一流程处置：先确认影响面，再按标准步骤收敛。

## 应做
- 先确认影响面再动手
- 处置完成后登记事件单

## 不应做
- 不要在未确认影响面时直接重启

## 反例 / 踩坑记录
上次直接重启导致二次故障。
`

function templateCard(): Card {
  return {
    id: 'rule-20250818-001' as Card['id'],
    type: 'rule',
    title: '处置标准：XX 类事件怎么办',
    库: 'personal',
    状态: 'draft',
    适用条件: '值班时收到 XX 类告警，需要统一处置口径',
    核心结论: 'XX 类事件按统一流程处置：先确认影响面，再按标准步骤收敛。',
    应做: ['先确认影响面再动手', '处置完成后登记事件单'],
    不应做: ['不要在未确认影响面时直接重启'],
    反例: '上次直接重启导致二次故障。',
    来源: 'MR#123',
    责任人: '张三',
    有效期: '2025-11-16',
    标签: ['告警处置', '值班'],
  }
}

describe('closed value sets', () => {
  it('accepts every member of each set and rejects anything else', () => {
    for (const value of CARD_TYPES) expect(isCardType(value)).toBe(true)
    for (const value of CARD_LIBRARIES) expect(isCardLibrary(value)).toBe(true)
    for (const value of CARD_STATUSES) expect(isCardStatus(value)).toBe(true)
    for (const value of CARD_TIERS) expect(isCardTier(value)).toBe(true)
    expect(isCardType('rule2')).toBe(false)
    expect(isCardType(42)).toBe(false)
    expect(isCardLibrary('work')).toBe(false)
    expect(isCardStatus('done')).toBe(false)
    expect(isCardTier('P4')).toBe(false)
    expect(isCardTier(undefined)).toBe(false)
  })
})

describe('isValidDateString', () => {
  it.each([
    ['2025-11-16', true],
    ['2024-02-29', true],
    ['2025-02-29', false],
    ['2025-13-01', false],
    ['2025-00-10', false],
    ['2025-01-32', false],
    ['2025-01-00', false],
    ['20251116', false],
    ['2025-1-1', false],
    ['', false],
  ])('accepts %s as %s', (value, expected) => {
    expect(isValidDateString(value)).toBe(expected)
  })
})

describe('parseCard', () => {
  it('parses the template into every field', () => {
    expect(parseCard(TEMPLATE, 'kb/cards/P2/rule-20250818-001.md')).toEqual(templateCard())
  })

  it('round-trips serialize → parse unchanged', () => {
    const card = templateCard()
    const text = serializeCard(card)
    expect(parseCard(text, 'kb/cards/P2/rule-20250818-001.md')).toEqual(card)
  })

  it('serializes the template key order with optional fields absent', () => {
    const { 反例, 来源, ...card } = templateCard()
    void 反例
    void 来源
    const text = serializeCard(card)
    const lines = text.split('\n')
    expect(lines[0]).toBe('---')
    const keys = lines.slice(1, lines.indexOf('---', 1))
      .filter(line => line !== '' && !line.startsWith(' '))
      .map(line => line.split(':')[0])
    expect(keys).toEqual(['id', 'type', 'title', '库', '状态', '适用条件', '责任人', '有效期', '标签'])
    expect(text).not.toContain('来源:')
    expect(text).not.toContain('反例')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('parses CRLF line endings and empty lists', () => {
    const { 反例, 来源, ...rest } = templateCard()
    void 反例
    void 来源
    const card = { ...rest, 应做: [], 不应做: [] }
    const crlf = serializeCard(card).replace(/\n/g, '\r\n')
    expect(parseCard(crlf, 'p.md')).toEqual(card)
  })

  it.each([
    ['missing front matter', 'body only', /missing YAML front matter/],
    ['unterminated front matter', '---\nid: x\n', /unterminated YAML front matter/],
    ['non-mapping front matter', '---\njust text\n---\n\n## 核心结论\nx', /must be a YAML mapping/],
    ['unknown key', TEMPLATE.replace('id: rule-20250818-001', 'id: rule-20250818-001\nids: oops'), /unknown front matter key\(s\) ids/],
    ['blank title', TEMPLATE.replace('title: 处置标准：XX 类事件怎么办', 'title: "  "'), /"title" must be a non-empty string/],
    ['bad type', TEMPLATE.replace('type: rule', 'type: tip'), /"type" must be one of/],
    ['bad library', TEMPLATE.replace('库: personal', '库: work'), /"库" must be one of/],
    ['bad status', TEMPLATE.replace('状态: draft', '状态: done'), /"状态" must be one of/],
    ['bad date format', TEMPLATE.replace('有效期: 2025-11-16', '有效期: 20251116'), /must be a YYYY-MM-DD calendar date/],
    ['impossible date', TEMPLATE.replace('有效期: 2025-11-16', '有效期: 2025-02-30'), /must be a YYYY-MM-DD calendar date/],
    ['blank owner', TEMPLATE.replace('责任人: 张三', '责任人: ""'), /"责任人" must be a non-empty string/],
    ['blank source', TEMPLATE.replace('来源: MR#123', '来源: " "'), /"来源" must be a non-empty string when present/],
    ['blank applies-to', TEMPLATE.replace('适用条件: 值班时收到 XX 类告警，需要统一处置口径', '适用条件: ""'), /"适用条件" must be a non-empty string/],
    ['tags not an array', TEMPLATE.replace('标签: [告警处置, 值班]', '标签: 告警处置'), /"标签" must be an array/],
    ['tag not a string', TEMPLATE.replace('标签: [告警处置, 值班]', '标签: [告警处置, 42]'), /"标签" item 1 must be a non-empty string/],
    ['unsafe id', TEMPLATE.replace('id: rule-20250818-001', 'id: ../escape'), /not a safe file name/],
    ['blank id', TEMPLATE.replace('id: rule-20250818-001', 'id: ""'), /"id" must be a non-empty string/],
  ])('fails loud on %s', (_name, text, message) => {
    expect(() => parseCard(text, 'bad.md')).toThrow(message)
  })

  it.each([
    ['unknown section', TEMPLATE.replace('## 反例 / 踩坑记录', '## 备注'), /unknown body section "## 备注"/],
    ['repeated section', TEMPLATE.replace('## 核心结论', '## 核心结论\n## 核心结论'), /"## 核心结论" repeats/],
    ['content before sections', TEMPLATE.replace('---\n\n## 核心结论', '---\n\nstray text\n## 核心结论'), /content before the first "## " section/],
    ['empty conclusion', TEMPLATE.replace('XX 类事件按统一流程处置：先确认影响面，再按标准步骤收敛。', ''), /"## 核心结论" must be non-empty/],
    ['non-list item in 应做', TEMPLATE.replace('- 先确认影响面再动手', '先确认影响面再动手'), /must contain only "- item" lines/],
    ['empty list item', TEMPLATE.replace('- 先确认影响面再动手', '-   '), /has an empty list item/],
  ])('fails loud on %s', (_name, text, message) => {
    expect(() => parseCard(text, 'bad.md')).toThrow(message)
  })

  it('accepts missing 应做/不应做 sections as empty lists', () => {
    const removed = TEMPLATE
      .replace('\n## 应做\n- 先确认影响面再动手\n- 处置完成后登记事件单\n', '')
      .replace('\n## 不应做\n- 不要在未确认影响面时直接重启\n', '')
    expect(parseCard(removed, 'p.md').应做).toEqual([])
    expect(parseCard(removed, 'p.md').不应做).toEqual([])
    // Headings with no items parse to empty lists as well.
    const empty = TEMPLATE
      .replace('- 先确认影响面再动手\n- 处置完成后登记事件单', '')
      .replace('- 不要在未确认影响面时直接重启', '')
    expect(parseCard(empty, 'p.md').应做).toEqual([])
    expect(parseCard(empty, 'p.md').不应做).toEqual([])
  })

  it('omits an empty 反例 section', () => {
    const text = TEMPLATE.replace('上次直接重启导致二次故障。', '')
    expect(parseCard(text, 'p.md').反例).toBeUndefined()
  })

  it('fails loud when the 核心结论 section is missing entirely', () => {
    const text = TEMPLATE.replace('## 核心结论\nXX 类事件按统一流程处置：先确认影响面，再按标准步骤收敛。\n', '')
    expect(() => parseCard(text, 'bad.md')).toThrow(/"## 核心结论" must be non-empty/)
  })
})
