/**
 * Knowledge-pack logic: config resolution, card selection, section rendering,
 * and the `kb:pack` prompt-section fold. All pure — the session-start
 * injection listener in `inject.ts` composes these; replay renders the same
 * section from `kb/injected` events alone.
 * @module @deepseek-ai/dsh-kb-core/pack
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CARD_LIBRARIES, CARD_STATUSES, CARD_TIERS } from './card.ts'
import type { Card, CardStatus, CardTier, KnowledgePack, PackSection } from './types.ts'

/** The `kb:pack` prompt-section name; the one model-visible face of injection. */
export const KB_PACK_SECTION = 'kb:pack'

/** Prompt order of the `kb:pack` section: after plan policy (50), before tool guidance (100+). */
export const KB_PACK_SECTION_ORDER = 60

/** Pack-level config keys, for the unknown-key rejection. */
const PACK_KEYS = ['name', 'tags', 'tier', 'library', 'status', 'limit'] as const

/** One library entry the pack selection consumes: a card plus its location. */
export interface PackEntry {
  /** The parsed card. */
  card: Card
  /** Personal-library tier; undefined for team cards (team cards have no tiers). */
  tier?: CardTier
  /** Absolute card file path. */
  path: string
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Validate one raw pack object into a detached `KnowledgePack`, failing loud. */
function resolvePack(value: unknown, index: number): KnowledgePack {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`KbConfig.packs[${index}] must be an object`)
  }
  const pack = value as Record<string, unknown>
  const unknown = Object.keys(pack).filter(key => !PACK_KEYS.includes(key as (typeof PACK_KEYS)[number]))
  if (unknown.length > 0) {
    throw new Error(`KbConfig.packs[${index}] has unknown key(s) ${unknown.join(', ')} — a pack is { name, tags?, tier?, status?, limit? }`)
  }
  const name = pack['name']
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`KbConfig.packs[${index}].name must be a non-empty string`)
  }
  const tags = resolveStringList(pack['tags'], index, 'tags')
  const tier = resolveEnums(pack['tier'], index, 'tier', CARD_TIERS)
  const library = resolveEnums(pack['library'], index, 'library', CARD_LIBRARIES)
  const status = resolveEnums(pack['status'], index, 'status', CARD_STATUSES)
  let limit: number | undefined
  if (pack['limit'] !== undefined) {
    const raw = pack['limit']
    if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
      throw new Error(`KbConfig.packs[${index}].limit must be a positive integer`)
    }
    limit = raw as number
  }
  return {
    name: name.trim(),
    ...tags === undefined ? {} : { tags },
    ...tier === undefined ? {} : { tier },
    ...library === undefined ? {} : { library },
    ...status === undefined ? {} : { status },
    ...limit === undefined ? {} : { limit },
  }
}

/** Validate an optional string-list field; duplicates are dropped. */
function resolveStringList(value: unknown, index: number, key: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`KbConfig.packs[${index}].${key} must be an array of non-empty strings`)
  return [...new Set(value.map((item, itemIndex) => {
    if (!isNonEmptyString(item)) {
      throw new Error(`KbConfig.packs[${index}].${key} item ${itemIndex} must be a non-empty string`)
    }
    return item
  }))]
}

/** Validate an optional closed-enum list field; unknown members fail loud. */
function resolveEnums<T extends string>(
  value: unknown,
  index: number,
  key: string,
  members: readonly T[],
): T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`KbConfig.packs[${index}].${key} must be a non-empty array of ${members.join(' | ')}`)
  }
  for (const item of value) {
    if (typeof item !== 'string' || !members.includes(item as T)) {
      throw new Error(`KbConfig.packs[${index}].${key} must contain only ${members.join(', ')}, got ${JSON.stringify(item)}`)
    }
  }
  return [...new Set(value)] as T[]
}

/**
 * Resolve and validate the configured packs; invalid packs fail loud at load.
 * @param value - the raw `packs` config field (absent when undefined).
 * @returns the validated packs, empty when not configured.
 */
export function resolvePacks(value: unknown): KnowledgePack[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('KbConfig.packs must be an array of pack objects')
  const packs = value.map((pack, index) => resolvePack(pack, index))
  const seen = new Set<string>()
  for (const pack of packs) {
    if (seen.has(pack.name)) throw new Error(`KbConfig.packs names must be unique, got duplicate ${JSON.stringify(pack.name)}`)
    seen.add(pack.name)
  }
  return packs
}

/** The default status exclusion: retired cards never auto-inject. */
const DEFAULT_EXCLUDED_STATUS: CardStatus = 'archived'

/** Whether one card entry passes a pack's filters. */
function passesPackFilters(entry: PackEntry, pack: KnowledgePack): boolean {
  if (pack.tags !== undefined && !pack.tags.every(tag => entry.card.标签.includes(tag))) return false
  if (pack.tier !== undefined && (entry.tier === undefined || !pack.tier.includes(entry.tier))) return false
  if (pack.library !== undefined && !pack.library.includes(entry.card.库)) return false
  if (pack.status !== undefined) {
    if (!pack.status.includes(entry.card.状态)) return false
  } else if (entry.card.状态 === DEFAULT_EXCLUDED_STATUS) {
    return false
  }
  return true
}

/**
 * Select the cards one pack subscribes to: filter by tags (every listed tag),
 * tier allowlist (personal tiers only), library allowlist, and status
 * allowlist (default excludes `archived`), sort by card id for determinism,
 * and cap at the pack's limit.
 * @param entries - the parsed libraries (personal entries carry a tier; team entries do not).
 * @param pack - the subscribed pack.
 * @returns the selected entries, id-ascending.
 */
export function selectPackCards(entries: readonly PackEntry[], pack: KnowledgePack): PackEntry[] {
  const selected = entries
    .filter(entry => passesPackFilters(entry, pack))
    .sort((left, right) => left.card.id.localeCompare(right.card.id))
  return pack.limit === undefined ? selected : selected.slice(0, pack.limit)
}

/**
 * Render one card as an injected section; the text is the replayable unit the
 * `kb:pack` fold renders. Content is the card's knowledge fields — title,
 * 适用条件, 核心结论, 应做 / 不应做, and the optional 反例 — without the
 * governance metadata (库 / 状态 / 责任人 / 有效期 / 标签).
 * @param card - the card to render.
 * @returns the section whose name is the card id.
 */
export function renderCardSection(card: Card): PackSection {
  return {
    name: card.id,
    text: [
      `标题：${card.title}`,
      `适用条件：${card.适用条件}`,
      `核心结论：${card.核心结论}`,
      `应做：${card.应做.join('；')}`,
      `不应做：${card.不应做.join('；')}`,
      ...card.反例 === undefined ? [] : [`反例：${card.反例}`],
    ].join('\n'),
  }
}

/**
 * Whether one pack was already injected into the session — the once-per-session
 * guard that keeps resume, fork, and re-emitted session-start idempotent.
 * @param events - the session log.
 * @param pack - the pack name.
 * @returns whether the log holds a `kb/injected` event for the pack.
 */
export function hasInjectedPack(events: readonly SessionEvent[], pack: string): boolean {
  return events.some(event => event.type === 'kb/injected' && event.data.pack === pack)
}

/**
 * Fold the session log into the `kb:pack` section text: every `kb/injected`
 * event in log order becomes one pack block, each card section one heading
 * plus its rendered text. Events without injected packs fold to the empty
 * string, so sessions without the kb plugin render nothing.
 * @param events - the session log or any prefix of it.
 * @returns the rendered section text.
 */
export function foldInjected(events: readonly SessionEvent[]): string {
  const packs: string[] = []
  for (const event of events) {
    if (event.type !== 'kb/injected') continue
    const cards = event.data.sections.map(section => `### ${section.name}\n${section.text}`).join('\n\n')
    packs.push(`## 知识包：${event.data.pack}\n\n${cards}`)
  }
  return packs.join('\n\n')
}
