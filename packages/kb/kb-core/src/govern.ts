/**
 * kb-govern pure logic: the first-gate evidence check, the three-tier quality
 * grade, the freshness partition, and the per-card review recommendation. All
 * functions are deterministic — the gate checks structural facts (evidence
 * presence, card completeness, 来源), never semantics, and the freshness
 * partition compares calendar dates only. The state transitions themselves
 * stay in `lifecycle.ts`; this module decides, the service and tools apply.
 * @module @deepseek-ai/dsh-kb-core/govern
 */

import type { Card, CardGrade, CardLibrary, CardStatus } from './types.ts'

/** The first-gate verdict: evidence satisfied (PASS) or not (BLOCK). */
export interface GateVerdict {
  /** `PASS` admits the card to the next stage; `BLOCK` lists why not. */
  verdict: 'PASS' | 'BLOCK'
  /** The blocking reasons; empty on PASS. */
  reasons: string[]
}

/** One card's freshness position relative to today. */
export interface FreshnessPosition {
  /** Whether the card's 有效期 is before today. */
  overdue: boolean
  /** Whether the card expires within the warning window (not yet overdue). */
  expiringSoon: boolean
  /** Days from today to 有效期; negative when overdue. */
  daysLeft: number
}

/** The freshness recommendation for one card, feeding archive/revive/review. */
export type FreshnessRecommendation = 'renew' | 'review' | 'archive-candidate' | 'revive-candidate'

/**
 * Evaluate the first gate (design §5.3): a personal draft with objective
 * evidence, a source link, and an executable checklist passes. The check is
 * structural — the evidence's truthfulness is the model's claim, recorded in
 * the tool call; kb enforces the bar, not the semantics.
 * @param card - the personal draft card under evaluation (undefined when not found).
 * @param evidence - the claimed objective signals (上线/交付/关闭/评审/复用).
 * @returns the verdict; BLOCK carries every violated rule as a reason.
 */
export function evaluateGate(card: Card | undefined, evidence: readonly string[]): GateVerdict {
  const reasons: string[] = []
  if (card === undefined) {
    reasons.push('card not found')
    return { verdict: 'BLOCK', reasons }
  }
  if (card.库 !== 'personal') reasons.push('only personal-library drafts pass the first gate')
  if (card.状态 !== 'draft') reasons.push(`first gate requires status draft, got ${card.状态}`)
  if (card.来源 === undefined) reasons.push('来源 (objective evidence link) is missing on the card')
  if (card.应做.length === 0 || card.不应做.length === 0) reasons.push('应做 and 不应做 must each have at least one item')
  if (evidence.length === 0) reasons.push('evidence is empty; provide at least one objective signal')
  for (const [index, item] of evidence.entries()) {
    if (item.trim() === '') reasons.push(`evidence item ${index} must be a non-empty string`)
  }
  return reasons.length === 0 ? { verdict: 'PASS', reasons: [] } : { verdict: 'BLOCK', reasons }
}

/**
 * Derive the three-tier quality grade (design §6): `verified` for active
 * cards inside their 有效期, `pending` while awaiting verification, and
 * `verify` for cards needing re-verification (past 有效期 or retired).
 * @param card - the card to grade.
 * @param today - the reference date in `YYYY-MM-DD` form.
 * @returns the derived grade.
 */
export function gradeCard(card: Card, today: string): CardGrade {
  switch (card.状态) {
    case 'draft':
    case 'pending':
      return 'pending'
    case 'archived':
      return 'verify'
    case 'ready':
    case 'revived':
      return card.有效期 < today ? 'verify' : 'verified'
  }
}

/**
 * Partition one card against today and the warning window.
 * @param card - the card.
 * @param today - the reference date in `YYYY-MM-DD` form.
 * @param warningDays - how many days ahead count as expiring soon (non-negative).
 * @returns the card's freshness position.
 */
export function freshnessPosition(card: Card, today: string, warningDays: number): FreshnessPosition {
  const daysLeft = Math.round((Date.parse(`${card.有效期}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  return {
    overdue: daysLeft < 0,
    expiringSoon: daysLeft >= 0 && daysLeft <= warningDays,
    daysLeft,
  }
}

/**
 * The freshness recommendation for one card: archived cards with consumption
 * are revive candidates, overdue pending cards need review, overdue active
 * cards are archive candidates when nothing consumed them and renew otherwise,
 * and expiring cards renew.
 * @param status - the card's lifecycle state.
 * @param heat - the card's consumption count from the heat ledger (0 when unknown).
 * @param position - the card's freshness position.
 * @returns the recommendation.
 */
export function recommendFreshness(
  status: CardStatus,
  heat: number,
  position: FreshnessPosition,
): FreshnessRecommendation {
  if (status === 'archived') return heat > 0 ? 'revive-candidate' : 'review'
  if (status === 'pending') return 'review'
  if (position.overdue) return heat > 0 ? 'renew' : 'archive-candidate'
  return 'renew'
}

/** One entry of the pending-review list produced by the freshness scan. */
export interface ReviewEntry {
  /** Card id. */
  id: string
  /** Card title. */
  title: string
  /** Library the card lives in. */
  library: CardLibrary
  /** Lifecycle state. */
  status: CardStatus
  /** Quality grade derived from status and expiry. */
  grade: CardGrade
  /** Expiry date `YYYY-MM-DD`. */
  有效期: string
  /** Days from the scan date to 有效期; negative when overdue. */
  daysLeft: number
  /** Consumption count from the heat ledger. */
  heat: number
  /** The governance recommendation. */
  recommend: FreshnessRecommendation
}

/**
 * Build one review-list entry from a card, its library, heat, and today.
 * @param card - the card.
 * @param library - the library the card lives in.
 * @param heat - the consumption count.
 * @param today - the scan date in `YYYY-MM-DD` form.
 * @param warningDays - the expiring-soon window in days.
 * @returns the review entry.
 */
export function toReviewEntry(
  card: Card,
  library: CardLibrary,
  heat: number,
  today: string,
  warningDays: number,
): ReviewEntry {
  const position = freshnessPosition(card, today, warningDays)
  return {
    id: card.id,
    title: card.title,
    library,
    status: card.状态,
    grade: gradeCard(card, today),
    有效期: card.有效期,
    daysLeft: position.daysLeft,
    heat,
    recommend: recommendFreshness(card.状态, heat, position),
  }
}

/** The freshness scan outcome: the pending-review list split into overdue and expiring-soon. */
export interface FreshnessReview {
  /** Cards past their 有效期. */
  overdue: ReviewEntry[]
  /** Cards expiring within the warning window. */
  expiringSoon: ReviewEntry[]
  /** Total flagged cards. */
  total: number
}

/**
 * Partition a scan into overdue and expiring-soon entries, id-ascending.
 * @param entries - the per-card scan entries.
 * @param warningDays - the expiring-soon window in days.
 * @returns the review list.
 */
export function partitionReview(entries: readonly ReviewEntry[], warningDays: number): FreshnessReview {
  const overdue = entries.filter(entry => entry.daysLeft < 0).sort((a, b) => a.id.localeCompare(b.id))
  const expiringSoon = entries
    .filter(entry => entry.daysLeft >= 0 && entry.daysLeft <= warningDays)
    .sort((a, b) => a.id.localeCompare(b.id))
  return { overdue, expiringSoon, total: overdue.length + expiringSoon.length }
}

/**
 * Render the pending-review list as the model- and human-facing text.
 * @param review - the scan outcome.
 * @param scanDate - the scan date in `YYYY-MM-DD` form.
 * @returns the rendered list, one line per flagged card.
 */
export function renderReviewList(review: FreshnessReview, scanDate: string): string {
  const lines = [`知识保鲜扫描（${scanDate}）：${review.total} 张卡片待复核`]
  for (const entry of review.overdue) {
    lines.push(`- [已过期] ${entry.id}（${entry.library}/${entry.status}）${entry.title}：有效期 ${entry.有效期}，已过期 ${-entry.daysLeft} 天，热度 ${entry.heat}，建议${recommendLabel(entry.recommend)}`)
  }
  for (const entry of review.expiringSoon) {
    lines.push(`- [即将过期] ${entry.id}（${entry.library}/${entry.status}）${entry.title}：有效期 ${entry.有效期}，剩余 ${entry.daysLeft} 天，热度 ${entry.heat}，建议${recommendLabel(entry.recommend)}`)
  }
  return lines.join('\n')
}

/** The model-facing label of one recommendation. */
function recommendLabel(recommend: FreshnessRecommendation): string {
  switch (recommend) {
    case 'renew': return '复核续期'
    case 'review': return '待复核'
    case 'archive-candidate': return '归档（零引用）'
    case 'revive-candidate': return '复活（仍有引用）'
  }
}
