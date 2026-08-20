// kb-govern pure logic coverage: the first-gate evidence check, the quality
// grade, the freshness partition, the review recommendation, and the review
// list rendering.
import { describe, expect, it } from 'vitest'
import {
  evaluateGate, freshnessPosition, gradeCard, partitionReview,
  recommendFreshness, renderReviewList, toReviewEntry,
} from '../src/govern.ts'
import type { Card, CardGrade } from '../src/types.ts'

/** A complete personal draft that should pass the gate. */
const DRAFT: Card = {
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

function cardWith(overrides: Partial<Card>): Card {
  return { ...DRAFT, ...overrides }
}

describe('evaluateGate', () => {
  it('passes a personal draft with evidence, source, and a checklist', () => {
    const verdict = evaluateGate(DRAFT, ['上线 MR#42', '事件单#88 已关闭'])
    expect(verdict).toEqual({ verdict: 'PASS', reasons: [] })
  })

  it('blocks a missing card with only the not-found reason', () => {
    expect(evaluateGate(undefined, ['上线'])).toEqual({
      verdict: 'BLOCK',
      reasons: ['card not found'],
    })
  })

  it('blocks a team-library card and a non-draft status', () => {
    const teamCard = cardWith({ 库: 'team', 状态: 'ready' })
    expect(evaluateGate(teamCard, ['上线']).reasons).toContain('only personal-library drafts pass the first gate')
    expect(evaluateGate(teamCard, ['上线']).reasons).toContain('first gate requires status draft, got ready')
  })

  it('blocks a card without a source link', () => {
    const { 来源: _来源, ...noSource } = DRAFT
    const reasons = evaluateGate(noSource, ['上线']).reasons
    expect(reasons).toContain('来源 (objective evidence link) is missing on the card')
  })

  it('blocks a card with an empty checklist side', () => {
    const reasons = evaluateGate(cardWith({ 不应做: [] }), ['上线']).reasons
    expect(reasons).toContain('应做 and 不应做 must each have at least one item')
  })

  it('blocks empty evidence and blank evidence items', () => {
    const empty = evaluateGate(DRAFT, [])
    expect(empty.verdict).toBe('BLOCK')
    expect(empty.reasons).toContain('evidence is empty; provide at least one objective signal')
    const blank = evaluateGate(DRAFT, ['  '])
    expect(blank.reasons).toContain('evidence item 0 must be a non-empty string')
  })
})

describe('gradeCard', () => {
  it('maps draft and pending to pending', () => {
    expect(gradeCard(cardWith({ 状态: 'draft' }), '2026-08-19')).toBe('pending')
    expect(gradeCard(cardWith({ 状态: 'pending' }), '2026-08-19')).toBe('pending')
  })

  it('maps archived to verify', () => {
    expect(gradeCard(cardWith({ 状态: 'archived' }), '2026-08-19')).toBe('verify')
  })

  it('maps ready/revived inside the validity window to verified and past it to verify', () => {
    const ready = cardWith({ 状态: 'ready', 有效期: '2026-12-31' })
    expect(gradeCard(ready, '2026-08-19')).toBe('verified')
    expect(gradeCard(ready, '2027-01-01')).toBe('verify')
    const revived = cardWith({ 状态: 'revived', 有效期: '2025-01-01' })
    expect(gradeCard(revived, '2026-08-19')).toBe('verify')
  })

  it('covers every status exactly once (the closed union)', () => {
    const statuses = ['draft', 'pending', 'ready', 'archived', 'revived'] as const
    const grades = statuses.map(status => gradeCard(cardWith({ 状态: status }), '2026-08-19'))
    expect(new Set<CardGrade>(grades)).toEqual(new Set<CardGrade>(['pending', 'verify', 'verified']))
  })
})

describe('freshnessPosition', () => {
  it('computes overdue, expiring-soon, and current positions', () => {
    expect(freshnessPosition(cardWith({ 有效期: '2026-08-01' }), '2026-08-19', 14)).toEqual({
      overdue: true, expiringSoon: false, daysLeft: -18,
    })
    expect(freshnessPosition(cardWith({ 有效期: '2026-08-25' }), '2026-08-19', 14)).toEqual({
      overdue: false, expiringSoon: true, daysLeft: 6,
    })
    expect(freshnessPosition(cardWith({ 有效期: '2027-01-01' }), '2026-08-19', 14)).toEqual({
      overdue: false, expiringSoon: false, daysLeft: 135,
    })
  })

  it('treats today as expiring-soon (daysLeft 0)', () => {
    expect(freshnessPosition(cardWith({ 有效期: '2026-08-19' }), '2026-08-19', 14).expiringSoon).toBe(true)
  })
})

describe('recommendFreshness', () => {
  it('revives archived cards with consumption and reviews those without', () => {
    expect(recommendFreshness('archived', 3, { overdue: true, expiringSoon: false, daysLeft: -1 })).toBe('revive-candidate')
    expect(recommendFreshness('archived', 0, { overdue: true, expiringSoon: false, daysLeft: -1 })).toBe('review')
  })

  it('reviews pending cards regardless of position', () => {
    expect(recommendFreshness('pending', 0, { overdue: true, expiringSoon: false, daysLeft: -1 })).toBe('review')
    expect(recommendFreshness('pending', 5, { overdue: false, expiringSoon: true, daysLeft: 3 })).toBe('review')
  })

  it('marks overdue active cards archive candidates when cold and renew when hot', () => {
    expect(recommendFreshness('ready', 0, { overdue: true, expiringSoon: false, daysLeft: -2 })).toBe('archive-candidate')
    expect(recommendFreshness('revived', 2, { overdue: true, expiringSoon: false, daysLeft: -2 })).toBe('renew')
  })

  it('renews active cards inside the window', () => {
    expect(recommendFreshness('ready', 0, { overdue: false, expiringSoon: true, daysLeft: 5 })).toBe('renew')
    expect(recommendFreshness('ready', 1, { overdue: false, expiringSoon: false, daysLeft: 100 })).toBe('renew')
  })
})

describe('toReviewEntry and partitionReview', () => {
  it('builds a review entry with grade, position, heat, and recommendation', () => {
    const entry = toReviewEntry(
      cardWith({ 状态: 'ready', 有效期: '2026-08-01' }),
      'team',
      2,
      '2026-08-19',
      14,
    )
    expect(entry).toMatchObject({
      id: 'rule-20260818-001',
      library: 'team',
      status: 'ready',
      grade: 'verify',
      有效期: '2026-08-01',
      daysLeft: -18,
      heat: 2,
      recommend: 'renew',
    })
  })

  it('partitions entries into overdue and expiring-soon, id-ascending', () => {
    const overdue = toReviewEntry(cardWith({ id: 'rule-20260818-002' as Card['id'], 有效期: '2026-01-01' }), 'personal', 0, '2026-08-19', 14)
    const soon = toReviewEntry(cardWith({ id: 'rule-20260818-001' as Card['id'], 有效期: '2026-08-25' }), 'personal', 0, '2026-08-19', 14)
    const soon2 = toReviewEntry(cardWith({ id: 'rule-20260818-000' as Card['id'], 有效期: '2026-08-26' }), 'personal', 0, '2026-08-19', 14)
    const current = toReviewEntry(cardWith({ id: 'rule-20260818-003' as Card['id'], 有效期: '2027-01-01' }), 'personal', 0, '2026-08-19', 14)
    const review = partitionReview([current, overdue, soon, soon2], 14)
    expect(review.total).toBe(3)
    expect(review.overdue.map(e => e.id)).toEqual(['rule-20260818-002'])
    expect(review.expiringSoon.map(e => e.id)).toEqual(['rule-20260818-000', 'rule-20260818-001'])
  })

  it('renders the review list with overdue and expiring lines and labels', () => {
    const entry = toReviewEntry(cardWith({ 状态: 'ready', 有效期: '2026-08-01' }), 'team', 0, '2026-08-19', 14)
    const text = renderReviewList({ overdue: [entry], expiringSoon: [], total: 1 }, '2026-08-19')
    expect(text).toContain('知识保鲜扫描（2026-08-19）：1 张卡片待复核')
    expect(text).toContain('[已过期] rule-20260818-001（team/ready）告警处置标准：有效期 2026-08-01，已过期 18 天，热度 0，建议归档（零引用）')
  })

  it('renders every recommendation label and the expiring-soon line', () => {
    const pendingEntry = toReviewEntry(cardWith({ 状态: 'pending', 有效期: '2026-08-01' }), 'team', 0, '2026-08-19', 14)
    const revivedEntry = toReviewEntry(cardWith({ 状态: 'archived', 有效期: '2025-01-01' }), 'team', 2, '2026-08-19', 14)
    const expiring = toReviewEntry(cardWith({ 状态: 'ready', 有效期: '2026-08-25' }), 'personal', 1, '2026-08-19', 14)
    const text = renderReviewList({ overdue: [pendingEntry, revivedEntry], expiringSoon: [expiring], total: 3 }, '2026-08-19')
    expect(text).toContain('建议待复核')
    expect(text).toContain('建议复活（仍有引用）')
    expect(text).toContain('[即将过期]')
    expect(text).toContain('建议复核续期')
  })
})
