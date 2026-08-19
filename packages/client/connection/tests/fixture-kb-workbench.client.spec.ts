/**
 * Fixture coverage for the kb governance workbench remote: the keyless
 * assembled-snapshot lane consumes these endpoints through the real client
 * bundles, so this spec pins the canned payloads at the fixture boundary (the
 * per-file 100% gate owns the fixture file).
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '../src/client/api.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'

const sid = (id: string): SessionId => id as SessionId

async function kbRpc(endpoint: string, args: Record<string, unknown>): Promise<{ ok: boolean } & Record<string, unknown>> {
  const client = new FixtureApiClient()
  return client.rpc.call('/api', endpoint, { args: { sessionId: sid('fx-alpha'), ...args } })
}

describe('fixture kbWorkbench remote', () => {
  it('serves the deterministic overview with the merged review list and flywheel metrics', async () => {
    const result = await kbRpc('kbWorkbench/overview', {})
    expect(result.ok).toBe(true)
    const value = result.value as {
      scanDate: string
      freshness: { overdue: { id: string }[]; expiringSoon: { id: string }[]; total: number }
      blindSpots: { sessionId: string; consumed: string[]; excerpt: string }[]
      metrics: { injections: number; promotions: number; pendingReview: number; blindSpots: number; topHeat: { cardId: string }[] }
    }
    expect(value.scanDate).toBe('2026-08-19')
    expect(value.freshness.total).toBe(2)
    expect(value.freshness.overdue[0]?.id).toBe('rule-20260720-001')
    expect(value.freshness.expiringSoon[0]?.id).toBe('rule-20260810-002')
    expect(value.blindSpots[0]).toMatchObject({ sessionId: sid('fx-blind-spot'), consumed: ['rule-20260818-001'] })
    expect(value.metrics).toMatchObject({ injections: 5, promotions: 2, pendingReview: 2, blindSpots: 1 })
    expect(value.metrics.topHeat[0]?.cardId).toBe('rule-20260720-001')
  })

  it('serves the draft card detail and every lifecycle action outcome', async () => {
    const card = await kbRpc('kbWorkbench/card', { id: 'rule-20260818-001' })
    expect(card.ok).toBe(true)
    expect((card.value as { card: { 状态: string } }).card.状态).toBe('draft')

    const promoted = await kbRpc('kbWorkbench/promote', { id: 'rule-20260818-001', target: 'pending' })
    expect((promoted.value as { 状态: string }).状态).toBe('pending')
    const archived = await kbRpc('kbWorkbench/archive', { id: 'rule-20260818-001' })
    expect((archived.value as { 状态: string }).状态).toBe('archived')
    const revived = await kbRpc('kbWorkbench/revive', { id: 'rule-20260818-001' })
    expect((revived.value as { 状态: string }).状态).toBe('revived')
    const reviewed = await kbRpc('kbWorkbench/review', { id: 'rule-20260818-001', approved: true })
    expect((reviewed.value as { 状态: string; changed: boolean }).changed).toBe(true)
  })

  it('applies a content edit to the served card detail', async () => {
    // One client instance: the fixture's card state is per-instance, so the
    // edit and the follow-up detail read must share it.
    const client = new FixtureApiClient()
    const rpc = (endpoint: string, args: Record<string, unknown>): ReturnType<typeof kbRpc> =>
      client.rpc.call('/api', endpoint, { args: { sessionId: sid('fx-alpha'), ...args } })
    const edited = await rpc('kbWorkbench/edit', {
      id: 'rule-20260818-001',
      patch: { title: '编辑后的标题', 标签: ['告警', '值班'] },
    })
    expect(edited.ok).toBe(true)
    expect((edited.value as { card: { title: string; 标签: string[] } }).card.title).toBe('编辑后的标题')
    // The detail endpoint now serves the edited card (the assembled journey
    // refreshes the detail after save).
    const card = await rpc('kbWorkbench/card', { id: 'rule-20260818-001' })
    expect((card.value as { card: { title: string; 标签: string[] } }).card).toMatchObject({
      title: '编辑后的标题', 标签: ['告警', '值班'],
    })
  })
})
