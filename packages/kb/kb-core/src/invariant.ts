/**
 * Package-owned durable `kb/*` event invariants: payload shapes and promotion
 * transition legality, checked against the session log. @module @deepseek-ai/dsh-kb-core/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { CardLibrary, CardStatus, CardTier } from './types.ts'

/* jscpd:ignore-start -- the companion mirrors the closed value sets so its bundle stays self-contained */
/** The two libraries of the shared card spec. */
const CARD_LIBRARIES = ['personal', 'team'] as const
/** The five lifecycle states of the promotion pipeline. */
const CARD_STATUSES = ['draft', 'pending', 'ready', 'archived', 'revived'] as const
/** The four personal-library tiers. */
const CARD_TIERS = ['P0', 'P1', 'P2', 'P3'] as const

/** The closed transition table of the promotion pipeline. */
const CARD_TRANSITIONS: readonly (readonly [CardStatus, CardStatus])[] = [
  ['draft', 'pending'],
  ['pending', 'ready'],
  ['ready', 'archived'],
  ['archived', 'revived'],
  ['revived', 'archived'],
] as const

/** Whether a transition is legal. */
function canTransition(from: CardStatus, to: CardStatus): boolean {
  return CARD_TRANSITIONS.some(([start, end]) => start === from && end === to)
}
/* jscpd:ignore-end */

const PACKAGE_NAME = '@deepseek-ai/dsh-kb-core'

/** Cordis companion plugin name. */
export const name = 'kb-core-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate a `kb/write` payload: every field is a non-empty string or closed-enum member. */
function validateWrite(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['id'] !== 'string' || data['id'] === '') fail('kb/write id must be a non-empty string')
  if (typeof data['library'] !== 'string' || !CARD_LIBRARIES.includes(data['library'] as CardLibrary)) {
    fail(`kb/write library must be one of ${CARD_LIBRARIES.join(', ')}`)
  }
  if (typeof data['tier'] !== 'string' || !CARD_TIERS.includes(data['tier'] as CardTier)) {
    fail(`kb/write tier must be one of ${CARD_TIERS.join(', ')}`)
  }
  if (typeof data['status'] !== 'string' || !CARD_STATUSES.includes(data['status'] as CardStatus)) {
    fail(`kb/write status must be one of ${CARD_STATUSES.join(', ')}`)
  }
  if (typeof data['title'] !== 'string' || data['title'] === '') fail('kb/write title must be a non-empty string')
  if (typeof data['path'] !== 'string' || data['path'] === '') fail('kb/write path must be a non-empty string')
}

/** Validate a `kb/promote` payload: closed-enum states, a legal transition, and an optional evidence string. */
function validatePromote(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['id'] !== 'string' || data['id'] === '') fail('kb/promote id must be a non-empty string')
  if (typeof data['from'] !== 'string' || !CARD_STATUSES.includes(data['from'] as CardStatus)) {
    fail(`kb/promote from must be one of ${CARD_STATUSES.join(', ')}`)
  }
  if (typeof data['to'] !== 'string' || !CARD_STATUSES.includes(data['to'] as CardStatus)) {
    fail(`kb/promote to must be one of ${CARD_STATUSES.join(', ')}`)
  }
  if (data['from'] === data['to']) fail('kb/promote must change the card state')
  if (!canTransition(data['from'] as CardStatus, data['to'] as CardStatus)) {
    fail(`kb/promote transition ${data['from']} → ${data['to']} is not in the state machine`)
  }
  if (data['evidence'] !== undefined && (typeof data['evidence'] !== 'string' || data['evidence'] === '')) {
    fail('kb/promote evidence must be a non-empty string when present')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'kb/write') validateWrite(event.data, fail)
  if (event.type === 'kb/promote') validatePromote(event.data, fail)
}

/** Install validation for loaded and newly appended kb events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the kb invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
