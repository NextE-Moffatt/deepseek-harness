/**
 * Runtime card model: the closed value sets, YAML front-matter parsing and
 * serialization, and the body-section mapping of the shared card spec (§4.2).
 * Parsing fails loud on unknown keys, missing required fields, malformed
 * dates, and unknown enum values; serialization reproduces the template shape.
 * @module @deepseek-ai/dsh-kb-core/card
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Card, CardId, CardLibrary, CardStatus, CardTier, CardType } from './types.ts'

/** The four knowledge-card types of the shared card spec. */
export const CARD_TYPES = ['rule', 'case', 'howto', 'decision'] as const
/** The two libraries of the shared card spec. */
export const CARD_LIBRARIES = ['personal', 'team'] as const
/** The five lifecycle states of the promotion pipeline. */
export const CARD_STATUSES = ['draft', 'pending', 'ready', 'archived', 'revived'] as const
/** The four personal-library tiers, each one a directory under `kb/cards/`. */
export const CARD_TIERS = ['P0', 'P1', 'P2', 'P3'] as const

/** YAML front-matter keys in template order. */
const FRONT_MATTER_KEYS = ['id', 'type', 'title', '库', '状态', '适用条件', '来源', '责任人', '有效期', '标签'] as const

/** Recognized body section headings in template order. */
const BODY_SECTIONS = ['核心结论', '应做', '不应做', '反例 / 踩坑记录'] as const

/** Ids must be safe file names; the `{type}-YYYYMMDD-{seq}` format is the generation convention, not a validation gate. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A date field value: `YYYY-MM-DD` on the real calendar. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Whether `value` is one of the four card types.
 * @param value - candidate value.
 * @returns true when `value` is a card type.
 */
export function isCardType(value: unknown): value is CardType {
  return CARD_TYPES.includes(value as CardType)
}

/**
 * Whether `value` is one of the two libraries.
 * @param value - candidate value.
 * @returns true when `value` is a library.
 */
export function isCardLibrary(value: unknown): value is CardLibrary {
  return CARD_LIBRARIES.includes(value as CardLibrary)
}

/**
 * Whether `value` is one of the five lifecycle states.
 * @param value - candidate value.
 * @returns true when `value` is a card status.
 */
export function isCardStatus(value: unknown): value is CardStatus {
  return CARD_STATUSES.includes(value as CardStatus)
}

/**
 * Whether `value` is one of the four personal tiers.
 * @param value - candidate value.
 * @returns true when `value` is a card tier.
 */
export function isCardTier(value: unknown): value is CardTier {
  return CARD_TIERS.includes(value as CardTier)
}

/**
 * Whether `value` is a real calendar date in `YYYY-MM-DD` form.
 * @param value - candidate value.
 * @returns true when the value names an existing calendar day.
 */
export function isValidDateString(value: string): boolean {
  const match = DATE_PATTERN.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** A validation failure with the offending card's source path in the message. */
class CardError extends Error {}

function fail(sourcePath: string, message: string): never {
  throw new CardError(`card at "${sourcePath}": ${message}`)
}

/** Trim a non-empty required string field, failing on blank values. */
function requiredString(sourcePath: string, key: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(sourcePath, `front matter key "${key}" must be a non-empty string`)
  }
  return value.trim()
}

/** Validate an optional string field, returning undefined for absent values. */
function optionalString(sourcePath: string, key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    fail(sourcePath, `front matter key "${key}" must be a non-empty string when present`)
  }
  return value.trim()
}

/** Validate a tag list: an array of non-empty strings (may be empty). */
function tagList(sourcePath: string, value: unknown): string[] {
  if (!Array.isArray(value)) fail(sourcePath, 'front matter key "标签" must be an array of strings')
  return value.map((tag, index) => {
    if (typeof tag !== 'string' || tag.trim() === '') {
      fail(sourcePath, `front matter key "标签" item ${index} must be a non-empty string`)
    }
    return tag.trim()
  })
}

/**
 * Split `text` into its YAML front matter and its markdown body. The front
 * matter must open the file with a `---` line and close with a `---` line.
 * @param text - the full card file text.
 * @param sourcePath - the card's source path, used in error messages.
 * @returns the front-matter lines and the body lines (both excluding the `---` fences).
 */
function splitFrontMatter(text: string, sourcePath: string): { frontMatter: string[]; body: string[] } {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') fail(sourcePath, 'missing YAML front matter (file must start with a "---" line)')
  const closing = lines.indexOf('---', 1)
  if (closing < 0) fail(sourcePath, 'unterminated YAML front matter (missing closing "---" line)')
  return { frontMatter: lines.slice(1, closing), body: lines.slice(closing + 1) }
}

/** Split the body into recognized sections, erroring on unknown `## ` headings and stray content. */
function parseBody(sourcePath: string, body: string[]): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let section: string[] | undefined
  for (const line of body) {
    if (line.startsWith('## ')) {
      const name = line.slice(3).trim()
      if (!(BODY_SECTIONS as readonly string[]).includes(name)) {
        fail(sourcePath, `unknown body section "## ${name}" (recognized: ${BODY_SECTIONS.join(', ')})`)
      }
      if (sections[name] !== undefined) fail(sourcePath, `body section "## ${name}" repeats`)
      sections[name] = []
      section = sections[name]
      continue
    }
    if (section === undefined) {
      if (line.trim() === '') continue
      fail(sourcePath, 'content before the first "## " section is not allowed')
    } else {
      section.push(line)
    }
  }
  return sections
}

/** Parse a list section's lines: `- item` lines with blank lines allowed between. */
function listSection(sourcePath: string, section: string, lines: string[]): string[] {
  const items: string[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    if (!line.startsWith('- ')) {
      fail(sourcePath, `body section "## ${section}" must contain only "- item" lines`)
    }
    const item = line.slice(2).trim()
    if (item === '') fail(sourcePath, `body section "## ${section}" has an empty list item`)
    items.push(item)
  }
  return items
}

/** Parse a paragraph section's lines into one trimmed string, or undefined when empty. */
function paragraphSection(lines: string[]): string | undefined {
  const text = lines.map(line => line.trim()).filter(line => line !== '').join('\n')
  return text === '' ? undefined : text
}

/**
 * Parse card file text into a validated {@link Card}.
 * @param text - the full card file text (front matter + body).
 * @param sourcePath - the card's source path, used in error messages.
 * @returns the validated card.
 */
export function parseCard(text: string, sourcePath: string): Card {
  const { frontMatter, body } = splitFrontMatter(text, sourcePath)
  const parsed: unknown = parseYaml(frontMatter.join('\n'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(sourcePath, 'front matter must be a YAML mapping')
  }
  const record = parsed as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !(FRONT_MATTER_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) fail(sourcePath, `unknown front matter key(s) ${unknown.join(', ')}`)

  const id = requiredString(sourcePath, 'id', record['id'])
  if (!ID_PATTERN.test(id)) fail(sourcePath, `front matter key "id" is not a safe file name: ${JSON.stringify(id)}`)
  const type = requiredString(sourcePath, 'type', record['type'])
  if (!isCardType(type)) fail(sourcePath, `front matter key "type" must be one of ${CARD_TYPES.join(', ')}`)
  const title = requiredString(sourcePath, 'title', record['title'])
  const library = requiredString(sourcePath, '库', record['库'])
  if (!isCardLibrary(library)) fail(sourcePath, `front matter key "库" must be one of ${CARD_LIBRARIES.join(', ')}`)
  const status = requiredString(sourcePath, '状态', record['状态'])
  if (!isCardStatus(status)) fail(sourcePath, `front matter key "状态" must be one of ${CARD_STATUSES.join(', ')}`)
  const appliesTo = requiredString(sourcePath, '适用条件', record['适用条件'])
  const source = optionalString(sourcePath, '来源', record['来源'])
  const owner = requiredString(sourcePath, '责任人', record['责任人'])
  const expiresAtRaw = record['有效期']
  if (typeof expiresAtRaw !== 'string' || !isValidDateString(expiresAtRaw.trim())) {
    // A bare numeric YAML scalar (20251116) would otherwise surface as a
    // type error; the date-format message is the honest diagnosis.
    fail(sourcePath, `front matter key "有效期" must be a YYYY-MM-DD calendar date, got ${JSON.stringify(expiresAtRaw)}`)
  }
  const expiresAt = expiresAtRaw.trim()
  const tags = tagList(sourcePath, record['标签'])

  const sections = parseBody(sourcePath, body)
  const conclusion = paragraphSection(sections['核心结论'] ?? [])
  if (conclusion === undefined) fail(sourcePath, 'body section "## 核心结论" must be non-empty')
  const shouldDo = listSection(sourcePath, '应做', sections['应做'] ?? [])
  const shouldNotDo = listSection(sourcePath, '不应做', sections['不应做'] ?? [])
  const counterExample = paragraphSection(sections['反例 / 踩坑记录'] ?? [])

  return {
    id: id as CardId,
    type,
    title,
    库: library,
    状态: status,
    适用条件: appliesTo,
    核心结论: conclusion,
    应做: shouldDo,
    不应做: shouldNotDo,
    ...counterExample === undefined ? {} : { 反例: counterExample },
    ...source === undefined ? {} : { 来源: source },
    责任人: owner,
    有效期: expiresAt,
    标签: tags,
  }
}

/**
 * Serialize a {@link Card} into the shared card template: YAML front matter in
 * template key order, then the body sections. The template's flow-style
 * `标签: [a, b]` renders as a block list, which is equivalent YAML.
 * @param card - the card to serialize.
 * @returns the full card file text, ending with exactly one newline.
 */
export function serializeCard(card: Card): string {
  const frontMatter: Record<string, unknown> = {
    id: card.id,
    type: card.type,
    title: card.title,
    库: card.库,
    状态: card.状态,
    适用条件: card.适用条件,
    ...card.来源 === undefined ? {} : { 来源: card.来源 },
    责任人: card.责任人,
    有效期: card.有效期,
    标签: card.标签,
  }
  const body = [
    '## 核心结论',
    card.核心结论,
    '',
    '## 应做',
    ...card.应做.map(item => `- ${item}`),
    '',
    '## 不应做',
    ...card.不应做.map(item => `- ${item}`),
    ...card.反例 === undefined ? [] : ['', '## 反例 / 踩坑记录', card.反例],
    '',
  ].join('\n')
  return `---\n${stringifyYaml(frontMatter)}---\n\n${body}`
}
