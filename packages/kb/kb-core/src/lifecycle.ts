/**
 * The promotion state machine: `draft → pending → ready → archived → revived`
 * with `revived → archived` re-archiving a restored card. `draft` is the
 * personal-library entry state; `pending` awaits verification; `ready` is the
 * reference pool; `archived` is retired; `revived` is a restored-active state,
 * distinct from never-archived `ready` for governance. `kb_promote` exposes
 * only the promotion subset (targets `pending` and `ready`).
 * @module @deepseek-ai/dsh-kb-core/lifecycle
 */

import type { CardStatus } from './types.ts'

/** The closed transition table of the promotion pipeline. */
export const CARD_TRANSITIONS: readonly (readonly [CardStatus, CardStatus])[] = [
  ['draft', 'pending'],
  ['pending', 'ready'],
  ['ready', 'archived'],
  ['archived', 'revived'],
  ['revived', 'archived'],
] as const

/**
 * Whether a transition is legal.
 * @param from - the current state.
 * @param to - the requested next state.
 * @returns true when the pair is in the transition table.
 */
export function canTransition(from: CardStatus, to: CardStatus): boolean {
  return CARD_TRANSITIONS.some(([start, end]) => start === from && end === to)
}

/**
 * Assert a transition is legal, failing loud otherwise.
 * @param from - the current state.
 * @param to - the requested next state.
 * @returns the `to` state, for chaining.
 */
export function assertTransition(from: CardStatus, to: CardStatus): CardStatus {
  if (!canTransition(from, to)) {
    throw new Error(`invalid card transition ${from} → ${to} (allowed: ${CARD_TRANSITIONS
      .map(([start, end]) => `${start} → ${end}`).join(', ')})`)
  }
  return to
}
