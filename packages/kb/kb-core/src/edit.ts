/**
 * Card-content editing: the closed patch contract, its validation, and the
 * apply/diff helpers behind `KbService.editCard`. The patch covers the
 * content fields only — the identity (`id`), library (`库`), and lifecycle
 * (`状态`) fields stay with the file name, the dual gate, and the state
 * machine respectively.
 * @module @deepseek-ai/dsh-kb-core/edit
 */

import { isCardType, isValidDateString } from './card.ts'
import type { Card, CardEditPatch } from './types.ts'

/** The content fields an edit may change, in template order. */
const EDITABLE_FIELDS = [
  'type', 'title', '适用条件', '核心结论', '应做', '不应做', '反例', '来源', '责任人', '有效期', '标签',
] as const

/** A trimmed optional field value; `null` means "explicitly cleared". */
type OptionalText = string | null | undefined

/** Trim a non-empty string patch value, failing on blanks. */
function requiredText(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`kb edit patch field "${field}" must be a non-empty string`)
  }
  return value.trim()
}

/** Normalize an optional patch value: absent keeps, empty clears, otherwise trimmed. */
function optionalText(field: string, value: unknown): OptionalText {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`kb edit patch field "${field}" must be a string when present`)
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Validate a string-list patch value; the list may be empty but items must not be blank. */
function stringList(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`kb edit patch field "${field}" must be an array of strings`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`kb edit patch field "${field}" item ${index} must be a non-empty string`)
    }
    return item.trim()
  })
}

/** A validated patch: `null` in `反例` / `来源` means "explicitly cleared". */
export type ValidatedCardEditPatch = Omit<CardEditPatch, '反例' | '来源'> & {
  反例?: string | null
  来源?: string | null
}

/**
 * Validate a card-edit patch at the wire boundary: a closed field set, closed
 * enums, calendar dates, and non-blank strings. Returns the trimmed patch;
 * `反例` / `来源` carry `null` when the patch cleared them.
 * @param patch - the raw patch.
 * @returns the validated patch with trimmed values.
 */
export function validateEditPatch(patch: CardEditPatch): ValidatedCardEditPatch {
  const record = patch as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !(EDITABLE_FIELDS as readonly string[]).includes(key))
  if (unknown.length > 0) throw new Error(`kb edit patch has unknown field(s): ${unknown.join(', ')}`)
  const type = record['type'] === undefined ? undefined : (() => {
    const value = requiredText('type', record['type'])
    if (!isCardType(value)) throw new Error('kb edit patch field "type" must be one of rule, case, howto, decision')
    return value
  })()
  const title = record['title'] === undefined ? undefined : requiredText('title', record['title'])
  const appliesTo = record['适用条件'] === undefined ? undefined : requiredText('适用条件', record['适用条件'])
  const conclusion = record['核心结论'] === undefined ? undefined : requiredText('核心结论', record['核心结论'])
  const shouldDo = record['应做'] === undefined ? undefined : stringList('应做', record['应做'])
  const shouldNotDo = record['不应做'] === undefined ? undefined : stringList('不应做', record['不应做'])
  const counterExample = optionalText('反例', record['反例'])
  const source = optionalText('来源', record['来源'])
  const owner = record['责任人'] === undefined ? undefined : requiredText('责任人', record['责任人'])
  const expiresAt = record['有效期'] === undefined ? undefined : (() => {
    const value = requiredText('有效期', record['有效期'])
    if (!isValidDateString(value)) {
      throw new Error(`kb edit patch field "有效期" must be a YYYY-MM-DD calendar date, got ${JSON.stringify(value)}`)
    }
    return value
  })()
  const tags = record['标签'] === undefined ? undefined : stringList('标签', record['标签'])
  return {
    ...type === undefined ? {} : { type },
    ...title === undefined ? {} : { title },
    ...appliesTo === undefined ? {} : { 适用条件: appliesTo },
    ...conclusion === undefined ? {} : { 核心结论: conclusion },
    ...shouldDo === undefined ? {} : { 应做: shouldDo },
    ...shouldNotDo === undefined ? {} : { 不应做: shouldNotDo },
    ...counterExample === undefined ? {} : { 反例: counterExample },
    ...source === undefined ? {} : { 来源: source },
    ...owner === undefined ? {} : { 责任人: owner },
    ...expiresAt === undefined ? {} : { 有效期: expiresAt },
    ...tags === undefined ? {} : { 标签: tags },
  }
}

/**
 * Apply a validated patch to a card, preserving the identity, library, and
 * lifecycle fields. A `null` optional field clears it (the key is removed, so
 * the result satisfies the optional-field type exactly).
 * @param card - the current card.
 * @param patch - the validated patch.
 * @returns the edited card.
 */
export function applyCardEdit(card: Card, patch: ValidatedCardEditPatch): Card {
  const result: Card = { ...card }
  if (patch.type !== undefined) result.type = patch.type
  if (patch.title !== undefined) result.title = patch.title
  if (patch.适用条件 !== undefined) result.适用条件 = patch.适用条件
  if (patch.核心结论 !== undefined) result.核心结论 = patch.核心结论
  if (patch.应做 !== undefined) result.应做 = patch.应做
  if (patch.不应做 !== undefined) result.不应做 = patch.不应做
  if (patch.反例 === null) delete result.反例
  else if (patch.反例 !== undefined) result.反例 = patch.反例
  if (patch.来源 === null) delete result.来源
  else if (patch.来源 !== undefined) result.来源 = patch.来源
  if (patch.责任人 !== undefined) result.责任人 = patch.责任人
  if (patch.有效期 !== undefined) result.有效期 = patch.有效期
  if (patch.标签 !== undefined) result.标签 = patch.标签
  return result
}

/**
 * The content fields whose value changed between two cards; the `kb/edit`
 * event's field list.
 * @param before - the card before the edit.
 * @param after - the card after the edit.
 * @returns the changed field names in template order.
 */
export function changedFields(before: Card, after: Card): string[] {
  const fields: string[] = []
  for (const field of EDITABLE_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) fields.push(field)
  }
  return fields
}
