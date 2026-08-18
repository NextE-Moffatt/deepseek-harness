import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PersonalCardStore } from '../src/store.ts'
import type { Card } from '../src/types.ts'

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id: id as Card['id'],
    type: 'rule',
    title: `卡片 ${id}`,
    库: 'personal',
    状态: 'draft',
    适用条件: '测试用',
    核心结论: '结论',
    应做: ['动作'],
    不应做: ['反动作'],
    责任人: '测试员',
    有效期: '2025-11-16',
    标签: ['t'],
    ...over,
  }
}

let roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function makeStore(cardsPath = 'kb/cards'): Promise<{ root: string; store: PersonalCardStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kb-store-'))
  roots.push(root)
  return { root, store: new PersonalCardStore(root, cardsPath) }
}

describe('PersonalCardStore', () => {
  it('lists cards across all tiers and reports parse failures per file', async () => {
    const { store } = await makeStore()
    await store.write(card('rule-20250818-001', { 状态: 'draft' }), 'P2')
    await store.write(card('rule-20250818-002'), 'P3')
    await store.write(card('howto-20250818-003'), 'P1')
    await writeFile(join(store.tierDir('P2'), 'broken.md'), 'not a card', 'utf8')
    await writeFile(join(store.libraryRoot, '.ingest-state.json'), '{}', 'utf8')
    const { cards, failures } = await store.list()
    expect(cards.map(entry => entry.card.id).sort()).toEqual([
      'howto-20250818-003', 'rule-20250818-001', 'rule-20250818-002',
    ])
    expect(cards.map(entry => entry.tier).sort()).toEqual(['P1', 'P2', 'P3'])
    expect(cards.every(entry => entry.path.startsWith(store.libraryRoot))).toBe(true)
    expect(cards.every(entry => Number.isFinite(entry.mtime) && entry.size > 0)).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.path.endsWith('broken.md')).toBe(true)
    expect(failures[0]?.message).toMatch(/missing YAML front matter/)
  })

  it('lists empty when the library does not exist yet', async () => {
    const { store } = await makeStore()
    expect(await store.list()).toEqual({ cards: [], failures: [] })
  })

  it('finds a card across tiers and reports not-found', async () => {
    const { store } = await makeStore()
    await store.write(card('rule-20250818-001'), 'P2')
    const info = await store.find('rule-20250818-001' as Card['id'])
    expect(info?.tier).toBe('P2')
    expect(info?.card.title).toBe('卡片 rule-20250818-001')
    expect(await store.find('missing-1' as Card['id'])).toBeUndefined()
  })

  it('writes a new card file and fails loud on id collision', async () => {
    const { store } = await makeStore()
    const path = await store.write(card('rule-20250818-001'), 'P2')
    expect(path).toBe(join(store.tierDir('P2'), 'rule-20250818-001.md'))
    expect(await readFile(path, 'utf8')).toContain('id: rule-20250818-001')
    await expect(store.write(card('rule-20250818-001'), 'P2')).rejects.toThrow(/already exists in tier P2/)
  })

  it('rewrites an existing card in place', async () => {
    const { store } = await makeStore()
    const path = await store.write(card('rule-20250818-001'), 'P2')
    const promoted: Card = { ...card('rule-20250818-001'), 状态: 'pending' }
    expect(await store.rewrite(promoted, 'P2')).toBe(path)
    expect((await store.find('rule-20250818-001' as Card['id']))?.card.状态).toBe('pending')
  })

  it('removes a card file and tolerates a missing one', async () => {
    const { store } = await makeStore()
    await store.write(card('rule-20250818-001'), 'P2')
    await store.remove('P2', 'rule-20250818-001' as Card['id'])
    expect(await store.find('rule-20250818-001' as Card['id'])).toBeUndefined()
    await store.remove('P2', 'missing' as Card['id'])
  })

  it('generates sequential zero-padded ids per type and day, ignoring foreign suffixes', async () => {
    const { store } = await makeStore()
    await store.write(card('rule-20250818-001'), 'P2')
    await store.write(card('rule-20250818-002'), 'P2')
    await store.write(card('rule-20250818-abc'), 'P2')
    await store.write(card('case-20250818-001'), 'P1')
    expect(await store.nextId('rule', '20250818')).toBe('rule-20250818-003' as Card['id'])
    expect(await store.nextId('case', '20250818')).toBe('case-20250818-002' as Card['id'])
    expect(await store.nextId('howto', '20250818')).toBe('howto-20250818-001' as Card['id'])
    expect(await store.nextId('rule', '20250819')).toBe('rule-20250819-001' as Card['id'])
  })

  it('resolves a configured nested cards path', async () => {
    const { root, store } = await makeStore('notes/lib/cards')
    await store.write(card('rule-20250818-001'), 'P0')
    expect(store.libraryRoot).toBe(join(root, 'notes/lib/cards'))
    expect(await store.find('rule-20250818-001' as Card['id'])).toBeDefined()
  })

  it('surfaces non-ENOENT directory errors', async () => {
    const { store } = await makeStore()
    // A file in place of a tier directory makes readdir fail with ENOTDIR.
    await mkdir(store.libraryRoot, { recursive: true })
    await writeFile(join(store.libraryRoot, 'P2'), 'not a directory', 'utf8')
    await expect(store.list()).rejects.toThrow(/ENOTDIR|not a directory|directory/)
    await expect(store.find('rule-20250818-001' as Card['id'])).rejects.toThrow()
  })

  it('skips non-file entries (directories) in tier listings', async () => {
    const { store } = await makeStore()
    await store.write(card('rule-20250818-001'), 'P2')
    await mkdir(join(store.tierDir('P2'), 'subdir'), { recursive: true })
    const { cards } = await store.list()
    expect(cards.map(entry => entry.card.id)).toEqual(['rule-20250818-001'])
  })

  it('surfaces non-EEXIST write errors', async () => {
    const { store } = await makeStore()
    // A read-only tier directory makes open('wx') fail with EACCES.
    await mkdir(store.tierDir('P2'), { recursive: true })
    await chmod(store.tierDir('P2'), 0o500)
    await expect(store.write(card('rule-20250818-001'), 'P2')).rejects.toThrow(/EACCES|permission/)
    await chmod(store.tierDir('P2'), 0o700)
  })
})
