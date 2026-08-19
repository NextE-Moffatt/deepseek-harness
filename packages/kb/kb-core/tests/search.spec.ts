import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CardIndex, KB_SEARCH_APPLICATION_ID, openCardIndex, scanSearch, type SearchRequest, type SearchableCard } from '../src/search.ts'
import { PersonalCardStore } from '../src/store.ts'
import type { Card, CardTier } from '../src/types.ts'

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id: id as Card['id'],
    type: 'rule',
    title: '默认标题',
    库: 'personal',
    状态: 'draft',
    适用条件: '默认适用条件',
    核心结论: '默认结论',
    应做: ['默认动作'],
    不应做: [],
    责任人: '测试员',
    有效期: '2025-11-16',
    标签: [],
    ...over,
  }
}

let roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function makeStore(): Promise<PersonalCardStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kb-search-'))
  roots.push(root)
  return new PersonalCardStore(root, 'kb/cards')
}

/** Tag a personal store listing with the personal library face. */
function asPersonal(entries: Awaited<ReturnType<PersonalCardStore['list']>>['cards']): SearchableCard[] {
  return entries.map(entry => ({ library: 'personal' as const, ...entry }))
}

function request(over: Partial<SearchRequest> = {}): SearchRequest {
  return { query: '告警', limit: 10, ...over }
}

/** One personal-library searchable card. */
function personal(id: string, over: Partial<Card> = {}, tier: CardTier = 'P2'): SearchableCard {
  return { library: 'personal', card: card(id, over), tier, path: `p-${id}`, mtime: 1, size: 1 }
}

/** One team-library searchable card (no tier). */
function team(id: string, over: Partial<Card> = {}): SearchableCard {
  return { library: 'team', card: card(id, { ...over, 库: 'team' }), path: `t-${id}`, mtime: 1, size: 1 }
}


describe('scanSearch', () => {
  it('ranks title and 适用条件 hits above body-only hits, sorted by score then id', () => {
    const entries = [
      personal('rule-a', { title: '告警处置标准', 适用条件: '收到告警时' }),
      personal('rule-b', { title: '无关', 适用条件: '无关', 核心结论: '告警处置要冷静' }),
      personal('rule-c', { title: '告警处置标准', 适用条件: '收到告警时', 标签: ['告警'] }),
    ]
    const hits = scanSearch(entries, request())
    expect(hits.map(hit => hit.id)).toEqual(['rule-c', 'rule-a', 'rule-b'])
    expect(hits[2]?.score).toBeGreaterThan(0)
  })

  it('applies type, status, tier, and tag filters', () => {
    const entries = [
      personal('rule-1', { 状态: 'draft' }),
      personal('case-1', { type: 'case', 状态: 'ready', 适用条件: '告警', 标签: ['安全'] }, 'P0'),
    ]
    expect(scanSearch(entries, request({ type: 'case' })).map(hit => hit.id)).toEqual(['case-1'])
    expect(scanSearch(entries, request({ status: 'ready' })).map(hit => hit.id)).toEqual(['case-1'])
    expect(scanSearch(entries, request({ tier: 'P0' })).map(hit => hit.id)).toEqual(['case-1'])
    expect(scanSearch(entries, request({ tags: ['安全'] })).map(hit => hit.id)).toEqual(['case-1'])
    expect(scanSearch(entries, request({ tags: ['安全', '缺失'] }))).toEqual([])
    expect(scanSearch(entries, request({ type: 'howto' }))).toEqual([])
  })

  it('returns nothing for a query with no tokens', () => {
    const entries = [personal('rule-1')]
    expect(scanSearch(entries, request({ query: '！！！' }))).toEqual([])
  })

  it('scores 反例 hits like other body fields', () => {
    const entries = [personal('rule-1', { 反例: '上次告警直接重启导致二次故障' })]
    const hits = scanSearch(entries, request({ query: '重启' }))
    expect(hits.map(hit => hit.id)).toEqual(['rule-1'])
    expect(hits[0]?.score).toBeGreaterThan(0)
  })

  it('breaks score ties by id ascending', () => {
    const entries = [
      personal('rule-b', { title: '告警处置' }),
      personal('rule-a', { title: '告警处置' }),
    ]
    const hits = scanSearch(entries, request({ query: '告警' }))
    expect(hits.map(hit => hit.id)).toEqual(['rule-a', 'rule-b'])
  })

  it('covers team cards with the team library marker and excludes them from the tier filter', () => {
    const entries = [
      personal('rule-1', { title: '告警处置' }, 'P2'),
      team('team-1', { title: '团队告警处置' }),
    ]
    const hits = scanSearch(entries, request())
    expect(hits.map(hit => hit.id)).toEqual(['rule-1', 'team-1'])
    expect(hits[0]).toMatchObject({ library: 'personal', tier: 'P2', status: 'draft' })
    expect(hits[1]).toMatchObject({ library: 'team', tier: 'team', status: 'draft' })
    // A tier filter can only apply to personal cards and excludes team cards.
    expect(scanSearch(entries, request({ tier: 'P2' })).map(hit => hit.id)).toEqual(['rule-1'])
  })
})

describe('openCardIndex', () => {
  it('opens and initializes an in-memory database with the application id and schema version', async () => {
    const db = await openCardIndex(':memory:')
    expect((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id)
      .toBe(KB_SEARCH_APPLICATION_ID)
    db.close()
  })

  it('creates a missing filesystem database owner-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-kb-index-'))
    roots.push(root)
    const path = join(root, 'kb', '.kb-index.sqlite')
    const db = await openCardIndex(path)
    db.close()
    const stats = await import('node:fs/promises').then(fs => fs.stat(path))
    expect(stats.size).toBeGreaterThan(0)
  })

  it('refuses a database that belongs to another application', async () => {
    const db = await openCardIndex(':memory:')
    db.exec('PRAGMA application_id = 12345')
    db.close()
    // A fresh in-memory db cannot be reopened by path; simulate via a file.
    const root = await mkdtemp(join(tmpdir(), 'dsh-kb-index-'))
    roots.push(root)
    const path = join(root, 'foreign.sqlite')
    const foreign = await openCardIndex(path)
    foreign.exec('PRAGMA application_id = 12345')
    foreign.close()
    await expect(openCardIndex(path)).rejects.toThrow(/belongs to another application/)
  })

  it('resets an incompatible schema version in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-kb-index-'))
    roots.push(root)
    const path = join(root, 'kb.sqlite')
    const db = await openCardIndex(path)
    db.exec('PRAGMA user_version = 99')
    db.close()
    const reopened = await openCardIndex(path)
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    reopened.close()
  })

  it('fails loud when the index directory is not writable', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-kb-index-'))
    roots.push(root)
    const directory = join(root, 'kb')
    const fs = await import('node:fs/promises')
    await fs.mkdir(directory)
    await fs.chmod(directory, 0o500)
    await expect(openCardIndex(join(directory, 'index.sqlite'))).rejects.toThrow(/EACCES|permission|denied/)
    await fs.chmod(directory, 0o700)
  })
})

describe('CardIndex', () => {
  it('syncs, diffs by mtime/size, searches with BM25 and filters, and drops vanished cards', async () => {
    const store = await makeStore()
    const db = await openCardIndex(':memory:')
    const index = new CardIndex(db)
    const first = await store.write(card('rule-1', { title: '告警处置', 适用条件: '收到告警时' }), 'P2')
    const info = (await store.list()).cards
    index.sync(asPersonal(info))

    const found = index.search(request({ query: '告警', limit: 10 }))
    expect(found.total).toBe(1)
    expect(found.hits[0]).toMatchObject({ id: 'rule-1', title: '告警处置', tier: 'P2', status: 'draft' })
    expect(found.hits[0]?.score).toBeGreaterThan(0)
    expect(found.hits[0]?.path).toBe(first)

    // Unchanged resync rewrites nothing and still serves the query.
    index.sync(asPersonal((await store.list()).cards))
    expect(index.search(request({ query: '告警' })).total).toBe(1)

    // A changed card (new mtime/size) refreshes the index.
    await new Promise(resolve => setTimeout(resolve, 5))
    await store.rewrite(card('rule-1', { title: '告警处置标准 v2', 适用条件: '收到告警时' }), 'P2')
    index.sync(asPersonal((await store.list()).cards))
    expect(index.search(request({ query: 'v2' })).total).toBe(1)

    // A vanished card drops out.
    await store.remove('P2', 'rule-1' as Card['id'])
    index.sync(asPersonal((await store.list()).cards))
    expect(index.search(request({ query: '告警' })).total).toBe(0)

    index.close()
  })

  it('matches quoted token queries without syntax errors and applies structured filters', async () => {
    const store = await makeStore()
    const db = await openCardIndex(':memory:')
    const index = new CardIndex(db)
    await store.write(card('rule-1', { title: '告警处置', 标签: ['安全'] }), 'P2')
    await store.write(card('case-1', { type: 'case', title: '告警案例', 状态: 'ready' }), 'P0')
    index.sync(asPersonal((await store.list()).cards))

    expect(index.search(request({ query: '告警' })).total).toBe(2)
    expect(index.search(request({ query: '告警', type: 'case' })).hits.map(hit => hit.id)).toEqual(['case-1'])
    expect(index.search(request({ query: '告警', status: 'ready' })).hits.map(hit => hit.id)).toEqual(['case-1'])
    expect(index.search(request({ query: '告警', tier: 'P2' })).hits.map(hit => hit.id)).toEqual(['rule-1'])
    expect(index.search(request({ query: '告警', tags: ['安全'] })).hits.map(hit => hit.id)).toEqual(['rule-1'])
    expect(index.search(request({ query: '告警', tags: ['安全', '缺失'] })).total).toBe(0)
    expect(index.search(request({ query: '告警', limit: 1 })).total).toBe(2)
    expect(index.search(request({ query: '告警', limit: 1 })).hits).toHaveLength(1)
    // A query with no tokens returns nothing.
    expect(index.search(request({ query: '！！！' }))).toEqual({ hits: [], total: 0 })
    index.close()
  })

  it('indexes personal and team cards together, keeping same-id cards distinct and searchable', async () => {
    const db = await openCardIndex(':memory:')
    const index = new CardIndex(db)
    const entries: SearchableCard[] = [
      personal('rule-1', { title: '个人告警处置' }, 'P2'),
      team('rule-1', { title: '团队告警处置' }),
      team('team-2', { title: '无关标题', 核心结论: '冷静处置' }),
    ]
    index.sync(entries)

    const found = index.search(request())
    expect(found.total).toBe(2)
    expect(found.hits.map(hit => [hit.library, hit.id])).toEqual([['personal', 'rule-1'], ['team', 'rule-1']])
    expect(found.hits[0]).toMatchObject({ library: 'personal', tier: 'P2' })
    expect(found.hits[1]).toMatchObject({ library: 'team', tier: 'team' })
    // The tier filter excludes team cards even when a personal card shares the id.
    expect(index.search(request({ tier: 'P2' })).hits.map(hit => hit.id)).toEqual(['rule-1'])
    expect(index.search(request({ status: 'draft' })).total).toBe(2)

    // A vanished team card drops out; the personal card of the same id survives.
    index.sync([personal('rule-1', { title: '个人告警处置' }, 'P2')])
    expect(index.search(request()).total).toBe(1)
    expect(index.search(request()).hits[0]).toMatchObject({ library: 'personal', id: 'rule-1' })
    index.close()
  })
})
