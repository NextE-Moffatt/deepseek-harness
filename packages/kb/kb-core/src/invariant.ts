/**
 * Package-owned durable `kb/*` event invariants: payload shapes, promotion
 * transition legality, and the card-id/section correspondence of injections,
 * checked against the session log. @module @deepseek-ai/dsh-kb-core/invariant
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

/** Validate a `kb/edit` payload: a non-empty card id, a closed-enum library, and a non-empty changed-field list. */
function validateEdit(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['id'] !== 'string' || data['id'] === '') fail('kb/edit id must be a non-empty string')
  if (typeof data['library'] !== 'string' || !CARD_LIBRARIES.includes(data['library'] as CardLibrary)) {
    fail(`kb/edit library must be one of ${CARD_LIBRARIES.join(', ')}`)
  }
  const fields = data['fields']
  if (!Array.isArray(fields) || fields.length === 0) fail('kb/edit fields must be a non-empty array')
  for (const field of fields) {
    if (typeof field !== 'string' || field === '') fail('kb/edit fields must contain only non-empty strings')
  }
}

/** Validate a `kb/injected` payload: a non-empty pack, and matching card-id and section faces. */
function validateInjected(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['pack'] !== 'string' || data['pack'] === '') fail('kb/injected pack must be a non-empty string')
  const cardIds = data['cardIds']
  const sections = data['sections']
  if (!Array.isArray(cardIds) || cardIds.length === 0) fail('kb/injected cardIds must be a non-empty array')
  if (!Array.isArray(sections) || sections.length === 0) fail('kb/injected sections must be a non-empty array')
  for (const id of cardIds) {
    if (typeof id !== 'string' || id === '') fail('kb/injected cardIds must contain only non-empty strings')
  }
  for (const section of sections) {
    const record = section as Record<string, unknown>
    if (typeof record['name'] !== 'string' || record['name'] === '') fail('kb/injected section name must be a non-empty string')
    if (typeof record['text'] !== 'string' || record['text'] === '') fail('kb/injected section text must be a non-empty string')
  }
  if (cardIds.length !== sections.length) fail('kb/injected cardIds and sections must have the same length')
  for (let index = 0; index < cardIds.length; index++) {
    if (cardIds[index] !== (sections[index] as Record<string, unknown>)['name']) {
      fail('kb/injected section names must equal the card ids in order')
    }
  }
}

/** Validate a `kb/team-join` payload: a non-empty card id, path, and a closed-enum status. */
function validateTeamJoin(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['id'] !== 'string' || data['id'] === '') fail('kb/team-join id must be a non-empty string')
  if (typeof data['path'] !== 'string' || data['path'] === '') fail('kb/team-join path must be a non-empty string')
  if (typeof data['status'] !== 'string' || !CARD_STATUSES.includes(data['status'] as CardStatus)) {
    fail(`kb/team-join status must be one of ${CARD_STATUSES.join(', ')}`)
  }
}

/** Validate a `kb/recap` payload: scan metadata, position and blind-spot arrays. */
function validateRecap(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['scanDate'] !== 'string' || data['scanDate'] === '') fail('kb/recap scanDate must be a non-empty string')
  const scanned = data['scanned']
  const blindSpots = data['blindSpots']
  if (!Array.isArray(scanned)) fail('kb/recap scanned must be an array')
  if (!Array.isArray(blindSpots)) fail('kb/recap blindSpots must be an array')
  for (const position of scanned) {
    const record = position as Record<string, unknown>
    if (typeof record['sessionId'] !== 'string' || record['sessionId'] === '') {
      fail('kb/recap scanned sessionId must be a non-empty string')
    }
    if (typeof record['eventCount'] !== 'number'
      || !Number.isInteger(record['eventCount'])
      || record['eventCount'] < 0) {
      fail('kb/recap scanned eventCount must be a non-negative integer')
    }
  }
  for (const spot of blindSpots) {
    const record = spot as Record<string, unknown>
    if (typeof record['sessionId'] !== 'string' || record['sessionId'] === '') {
      fail('kb/recap blindSpots sessionId must be a non-empty string')
    }
    if (typeof record['at'] !== 'string' || record['at'] === '') fail('kb/recap blindSpots at must be a non-empty string')
    if (!Array.isArray(record['consumed']) || (record['consumed'] as unknown[]).some(id => typeof id !== 'string' || id === '')) {
      fail('kb/recap blindSpots consumed must be an array of non-empty strings')
    }
  }
  if (typeof data['total'] !== 'number'
    || !Number.isInteger(data['total'])
    || data['total'] < 0) {
    fail('kb/recap total must be a non-negative integer')
  }
  if (typeof data['listed'] !== 'number'
    || !Number.isInteger(data['listed'])
    || data['listed'] < 0) {
    fail('kb/recap listed must be a non-negative integer')
  }
}

/** Validate a `kb/doc-write` payload: a non-empty doc path and a non-negative byte size. */
function validateDocWrite(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['path'] !== 'string' || data['path'] === '') fail('kb/doc-write path must be a non-empty string')
  if (typeof data['size'] !== 'number' || !Number.isInteger(data['size']) || data['size'] < 0) {
    fail('kb/doc-write size must be a non-negative integer')
  }
}

/** Validate a `kb/doc-remove` payload: a non-empty doc path. */
function validateDocRemove(value: unknown, fail: InvariantFailure): void {
  const data = value as Record<string, unknown>
  if (typeof data['path'] !== 'string' || data['path'] === '') fail('kb/doc-remove path must be a non-empty string')
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'kb/write') validateWrite(event.data, fail)
  if (event.type === 'kb/edit') validateEdit(event.data, fail)
  if (event.type === 'kb/promote') validatePromote(event.data, fail)
  if (event.type === 'kb/injected') validateInjected(event.data, fail)
  if (event.type === 'kb/team-join') validateTeamJoin(event.data, fail)
  if (event.type === 'kb/recap') validateRecap(event.data, fail)
  if (event.type === 'kb/doc-write') validateDocWrite(event.data, fail)
  if (event.type === 'kb/doc-remove') validateDocRemove(event.data, fail)
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
