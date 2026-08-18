import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importDir } from '../src/ingest.ts'
import { PersonalCardStore } from '../src/store.ts'
import type { Card } from '../src/types.ts'

const CARD_TEXT = `---
id: rule-20250818-001
type: rule
title: 来自数据源的规则
库: team
状态: ready
适用条件: 数据源场景
责任人: 数据员
有效期: 2025-11-16
标签: [导入]
---

## 核心结论
数据源结论

## 应做
- 数据源动作

## 不应做
- 数据源反动作
`

let roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function makeWorkspace(): Promise<{ root: string; store: PersonalCardStore; sourceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kb-ingest-'))
  roots.push(root)
  const sourceDir = join(root, 'sources')
  await mkdir(sourceDir)
  await mkdir(join(root, 'kb', 'cards'), { recursive: true })
  return { root, store: new PersonalCardStore(root, 'kb/cards'), sourceDir }
}

describe('importDir', () => {
  it('imports card-shaped files as personal drafts with 来源 defaulting to the source path', async () => {
    const { store, sourceDir } = await makeWorkspace()
    const source = join(sourceDir, 'nested', 'rule.md')
    await mkdir(join(sourceDir, 'nested'))
    await writeFile(source, CARD_TEXT, 'utf8')
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(result).toEqual({ imported: ['rule-20250818-001' as Card['id']], skipped: 0, skippedRaw: 0 })
    const info = await store.find('rule-20250818-001' as Card['id'])
    expect(info?.tier).toBe('P2')
    expect(info?.card).toMatchObject({ 库: 'personal', 状态: 'draft', 来源: source, title: '来自数据源的规则' })
  })

  it('skips unchanged files via the checkpoint and re-imports changed ones, preserving status', async () => {
    const { store, sourceDir } = await makeWorkspace()
    const source = join(sourceDir, 'rule.md')
    await writeFile(source, CARD_TEXT, 'utf8')
    await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    await store.rewrite({ ...(await store.find('rule-20250818-001' as Card['id']))!.card, 状态: 'pending' }, 'P2')

    const second = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(second).toEqual({ imported: [], skipped: 1, skippedRaw: 0 })

    await new Promise(resolve => setTimeout(resolve, 5))
    await writeFile(source, CARD_TEXT.replace('数据源结论', '数据源结论 v2 —— 更长的结论内容'), 'utf8')
    const third = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(third.imported).toEqual(['rule-20250818-001' as Card['id']])
    const info = await store.find('rule-20250818-001' as Card['id'])
    expect(info?.card.状态).toBe('pending')
    expect(info?.card.核心结论).toBe('数据源结论 v2 —— 更长的结论内容')
  })

  it('skips and counts raw non-card files without importing them', async () => {
    const { store, sourceDir } = await makeWorkspace()
    const raw = join(sourceDir, 'note.md')
    await writeFile(raw, '# 随手记\n随便写点什么\n', 'utf8')
    await writeFile(join(sourceDir, 'readme.txt'), 'not markdown', 'utf8')
    await writeFile(join(sourceDir, 'card.md'), CARD_TEXT, 'utf8')
    const first = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(first).toEqual({ imported: ['rule-20250818-001' as Card['id']], skipped: 0, skippedRaw: 1 })
    expect(await store.find('rule-20250818-001' as Card['id'])).toBeDefined()

    // Unchanged raw files stay skipped.
    const second = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(second.skipped).toBe(1)
    expect(second.skippedRaw).toBe(1)
  })

  it('prunes checkpoint entries for vanished source files', async () => {
    const { store, sourceDir } = await makeWorkspace()
    const source = join(sourceDir, 'rule.md')
    await writeFile(source, CARD_TEXT, 'utf8')
    await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    const statePath = join(store.libraryRoot, '.ingest-state.json')
    expect(Object.keys(JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>)).toEqual([source])
    await import('node:fs/promises').then(fs => fs.rm(source))
    await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(Object.keys(JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>)).toEqual([])
  })

  it('returns an empty outcome for a missing source directory', async () => {
    const { store, sourceDir } = await makeWorkspace()
    expect(await importDir(store, { root: store.root, sourceDir: join(sourceDir, 'gone'), tier: 'P2' }))
      .toEqual({ imported: [], skipped: 0, skippedRaw: 0 })
  })

  it('fails loud on a corrupt checkpoint', async () => {
    const { store } = await makeWorkspace()
    await writeFile(join(store.libraryRoot, '.ingest-state.json'), 'not json', 'utf8')
    await expect(importDir(store, { root: store.root, sourceDir: '/nonexistent', tier: 'P2' }))
      .rejects.toThrow(/checkpoint/)
  })

  it('fails loud on a malformed checkpoint entry', async () => {
    const { store } = await makeWorkspace()
    await writeFile(join(store.libraryRoot, '.ingest-state.json'), '{"x": {"mtime": "soon"}}', 'utf8')
    await expect(importDir(store, { root: store.root, sourceDir: '/nonexistent', tier: 'P2' }))
      .rejects.toThrow(/corrupt/)
  })

  it('fails loud on a checkpoint that is not a mapping and on a malformed cardId', async () => {
    const { store } = await makeWorkspace()
    await writeFile(join(store.libraryRoot, '.ingest-state.json'), '[1, 2]', 'utf8')
    await expect(importDir(store, { root: store.root, sourceDir: '/nonexistent', tier: 'P2' }))
      .rejects.toThrow(/corrupt/)
    await writeFile(join(store.libraryRoot, '.ingest-state.json'), '{"x": {"cardId": 5, "mtime": 1, "size": 1}}', 'utf8')
    await expect(importDir(store, { root: store.root, sourceDir: '/nonexistent', tier: 'P2' }))
      .rejects.toThrow(/corrupt/)
    await writeFile(join(store.libraryRoot, '.ingest-state.json'), '{"x": null}', 'utf8')
    await expect(importDir(store, { root: store.root, sourceDir: '/nonexistent', tier: 'P2' }))
      .rejects.toThrow(/corrupt/)
  })

  it('surfaces a non-ENOENT walk error when the source directory is a file', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await writeFile(join(sourceDir, 'blocker.md'), 'x', 'utf8')
    await expect(importDir(store, { root: store.root, sourceDir: join(sourceDir, 'blocker.md'), tier: 'P2' }))
      .rejects.toThrow()
  })
})
