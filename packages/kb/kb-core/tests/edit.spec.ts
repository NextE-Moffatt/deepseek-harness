/**
 * Unit coverage of the card-edit seam: the closed patch validation, the
 * apply helper (identity/library/lifecycle preserved), and the changed-field
 * diff behind `KbService.editCard`.
 */
import { describe, expect, it } from 'vitest'
import { applyCardEdit, changedFields, validateEditPatch } from '../src/edit.ts'
import type { Card } from '../src/types.ts'

/** A complete personal draft card to edit. */
const CARD: Card = {
  id: 'rule-20260818-001' as Card['id'],
  type: 'rule',
  title: '告警处置标准',
  库: 'personal',
  状态: 'draft',
  适用条件: '值班收到告警',
  核心结论: '先确认影响面。',
  应做: ['确认影响面'],
  不应做: ['直接重启'],
  来源: 'MR#42',
  责任人: '张三',
  有效期: '2026-12-31',
  标签: ['告警'],
}

describe('validateEditPatch', () => {
  it('returns the trimmed patch for valid fields', () => {
    expect(validateEditPatch({
      type: 'howto',
      title: ' 新标题 ',
      适用条件: ' 新条件 ',
      核心结论: ' 新结论 ',
      应做: [' 动作 '],
      不应做: [],
      反例: ' 反例 ',
      来源: ' 新来源 ',
      责任人: ' 李四 ',
      有效期: ' 2027-01-01 ',
      标签: [' 新标签 '],
    })).toEqual({
      type: 'howto',
      title: '新标题',
      适用条件: '新条件',
      核心结论: '新结论',
      应做: ['动作'],
      不应做: [],
      反例: '反例',
      来源: '新来源',
      责任人: '李四',
      有效期: '2027-01-01',
      标签: ['新标签'],
    })
  })

  it('rejects an unknown field and a non-card type', () => {
    expect(() => validateEditPatch({ 库: 'team' } as never)).toThrow(/unknown field/)
    expect(() => validateEditPatch({ type: 'note' as never })).toThrow(/must be one of rule, case, howto, decision/)
  })

  it('rejects blank required fields and blank list items', () => {
    expect(() => validateEditPatch({ title: '  ' })).toThrow(/title.*non-empty string/)
    expect(() => validateEditPatch({ 适用条件: '' })).toThrow(/non-empty string/)
    expect(() => validateEditPatch({ 核心结论: 'x', 责任人: '' })).toThrow(/non-empty string/)
    expect(() => validateEditPatch({ 应做: ['ok', '  '] })).toThrow(/item 1 must be a non-empty string/)
    expect(() => validateEditPatch({ 标签: 'not-an-array' as never })).toThrow(/must be an array of strings/)
  })

  it('rejects a malformed 有效期 and a malformed optional string', () => {
    expect(() => validateEditPatch({ 有效期: '2026-13-01' })).toThrow(/YYYY-MM-DD calendar date/)
    expect(() => validateEditPatch({ 来源: 42 as never })).toThrow(/must be a string when present/)
  })

  it('keeps absent optional fields and clears them with an empty string', () => {
    expect(validateEditPatch({ title: '新标题' }).反例).toBeUndefined()
    expect(validateEditPatch({ title: '新标题', 反例: '' }).反例).toBeNull()
    expect(validateEditPatch({ title: '新标题', 来源: ' ' }).来源).toBeNull()
  })

  it('accepts an empty patch', () => {
    expect(validateEditPatch({})).toEqual({})
  })
})

describe('applyCardEdit', () => {
  it('applies only the present fields and preserves identity, library, and lifecycle', () => {
    const edited = applyCardEdit(CARD, validateEditPatch({ title: '新标题', 标签: ['告警', '值班'] }))
    expect(edited).toMatchObject({ id: CARD.id, type: 'rule', 库: 'personal', 状态: 'draft', title: '新标题', 标签: ['告警', '值班'] })
    expect(edited.核心结论).toBe(CARD.核心结论)
  })

  it('applies a full patch across every content field', () => {
    const edited = applyCardEdit(CARD, validateEditPatch({
      type: 'howto',
      title: '新标题',
      适用条件: '新条件',
      核心结论: '新结论',
      应做: ['动作一'],
      不应做: ['反动作'],
      反例: '新反例',
      来源: '新来源',
      责任人: '李四',
      有效期: '2027-01-01',
      标签: ['新标签'],
    }))
    expect(edited).toMatchObject({
      id: CARD.id, type: 'howto', title: '新标题', 适用条件: '新条件', 核心结论: '新结论',
      应做: ['动作一'], 不应做: ['反动作'], 反例: '新反例', 来源: '新来源',
      责任人: '李四', 有效期: '2027-01-01', 标签: ['新标签'], 库: 'personal', 状态: 'draft',
    })
  })

  it('clears 反例 and 来源 with a null marker', () => {
    const edited = applyCardEdit({ ...CARD, 反例: '旧反例' }, validateEditPatch({ 反例: '', 来源: '' }))
    expect(edited.反例).toBeUndefined()
    expect(edited.来源).toBeUndefined()
  })
})

describe('changedFields', () => {
  it('lists only the changed content fields in template order', () => {
    const edited = applyCardEdit(CARD, validateEditPatch({ title: '新标题', 标签: ['值班'], 适用条件: '新条件' }))
    expect(changedFields(CARD, edited)).toEqual(['title', '适用条件', '标签'])
  })

  it('returns an empty list when nothing changed', () => {
    expect(changedFields(CARD, { ...CARD })).toEqual([])
    expect(changedFields(CARD, applyCardEdit(CARD, validateEditPatch({})))).toEqual([])
  })

  it('detects a cleared optional field', () => {
    const cleared = applyCardEdit(CARD, validateEditPatch({ 来源: '' }))
    expect(changedFields(CARD, cleared)).toEqual(['来源'])
  })
})
