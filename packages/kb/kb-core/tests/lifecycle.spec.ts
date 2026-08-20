import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition, CARD_TRANSITIONS } from '../src/lifecycle.ts'

describe('promotion state machine', () => {
  it('allows exactly the closed chain draft → pending → ready → archived → revived and revived → archived', () => {
    expect(CARD_TRANSITIONS).toEqual([
      ['draft', 'pending'],
      ['pending', 'ready'],
      ['ready', 'archived'],
      ['archived', 'revived'],
      ['revived', 'archived'],
    ])
    expect(canTransition('draft', 'pending')).toBe(true)
    expect(canTransition('pending', 'ready')).toBe(true)
    expect(canTransition('ready', 'archived')).toBe(true)
    expect(canTransition('archived', 'revived')).toBe(true)
    expect(canTransition('revived', 'archived')).toBe(true)
  })

  it.each([
    ['draft', 'ready'],
    ['draft', 'archived'],
    ['draft', 'draft'],
    ['pending', 'draft'],
    ['ready', 'pending'],
    ['ready', 'revived'],
    ['archived', 'ready'],
    ['revived', 'draft'],
    ['revived', 'ready'],
  ])('rejects %s → %s', (from, to) => {
    expect(canTransition(from as never, to as never)).toBe(false)
    expect(() => assertTransition(from as never, to as never)).toThrow(/invalid card transition/)
  })

  it('assertTransition returns the target state', () => {
    expect(assertTransition('draft', 'pending')).toBe('pending')
  })
})
