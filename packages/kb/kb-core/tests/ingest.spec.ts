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

describe('raw-note wrapping', () => {
  it('wraps a raw note with a heading into a draft howto card with inferred fields', async () => {
    const { store, sourceDir } = await makeWorkspace()
    const source = join(sourceDir, 'note.md')
    await writeFile(source, '# 值班记录\n\n先确认影响面，再处置。\n- 记录一\n- 记录二\n', 'utf8')
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(result.skippedRaw).toBe(0)
    expect(result.imported).toHaveLength(1)
    const id = result.imported[0]!
    expect(id).toMatch(/^howto-\d{8}-001$/)
    const info = await store.find(id)
    expect(info?.tier).toBe('P2')
    expect(info?.card).toMatchObject({
      id, type: 'howto', title: '值班记录',
      库: 'personal', 状态: 'draft',
      适用条件: '先确认影响面，再处置。',
      核心结论: '先确认影响面，再处置。\n- 记录一\n- 记录二',
      应做: [], 不应做: [],
      来源: source, 责任人: '导入', 标签: [],
    })
    expect(info?.card.有效期).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('falls back to the basename when the note has no heading and derives no tag at the source root', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await writeFile(join(sourceDir, 'plain-notes.md'), '没有标题的内容\n', 'utf8')
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    const card = (await store.find(result.imported[0]!))!.card
    expect(card.title).toBe('plain-notes')
    expect(card.标签).toEqual([])
  })

  it('derives one tag from the parent directory of a nested note', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await mkdir(join(sourceDir, '运维'))
    await writeFile(join(sourceDir, '运维', 'deep.md'), '# 深目录\n# 二级标题\n正文行\n', 'utf8')
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    const card = (await store.find(result.imported[0]!))!.card
    expect(card.标签).toEqual(['运维'])
    // The conclusion drops heading lines so re-parsing stays valid.
    expect(card.核心结论).toBe('正文行')
  })

  it('skips and counts empty and heading-only notes without importing them', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await writeFile(join(sourceDir, 'empty.md'), '', 'utf8')
    await writeFile(join(sourceDir, 'heading-only.md'), '# 只有标题\n', 'utf8')
    const first = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(first).toEqual({ imported: [], skipped: 0, skippedRaw: 2 })
    // Unchanged unwrappable notes skip via the checkpoint.
    const second = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(second.skippedRaw).toBe(2)
    expect(second.skipped).toBe(0)
  })

  it('skips and counts a front-matter-malformed file instead of wrapping it', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await writeFile(join(sourceDir, 'broken.md'), '---\nid: rule-20250818-099\n---\n正文\n', 'utf8')
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(result).toEqual({ imported: [], skipped: 0, skippedRaw: 1 })
    expect(await store.find('rule-20250818-099' as Card['id'])).toBeUndefined()
  })

  it('counts non-markdown files as skipped raw every run without checkpointing them', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await writeFile(join(sourceDir, 'readme.txt'), 'not markdown', 'utf8')
    await writeFile(join(sourceDir, 'card.md'), CARD_TEXT, 'utf8')
    const first = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(first.skippedRaw).toBe(1)
    expect(first.imported).toEqual(['rule-20250818-001' as Card['id']])
    // The card is checkpointed; the text file is recounted.
    const second = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(second).toEqual({ imported: [], skipped: 1, skippedRaw: 1 })
  })

  it('ignores symlink entries that are neither directories nor files', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await writeFile(join(sourceDir, 'target.md'), '# 目标\n内容\n', 'utf8')
    await import('node:fs/promises').then(fs => fs.symlink(join(sourceDir, 'target.md'), join(sourceDir, 'link.md')))
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(result).toEqual({ imported: [expect.stringMatching(/^howto-\d{8}-001$/) as Card['id']], skipped: 0, skippedRaw: 0 })
  })

  it('re-wraps a changed source into the same card, preserving its current status', async () => {
    const { store, sourceDir } = await makeWorkspace()
    const source = join(sourceDir, 'note.md')
    await writeFile(source, '# 原始笔记\n原始结论\n', 'utf8')
    const first = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    const id = first.imported[0]!
    await store.rewrite({ ...(await store.find(id))!.card, 状态: 'pending' }, 'P2')

    await new Promise(resolve => setTimeout(resolve, 5))
    await writeFile(source, '# 原始笔记\n更新后的结论\n', 'utf8')
    const second = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(second.imported).toEqual([id])
    const info = await store.find(id)
    expect(info?.card.状态).toBe('pending')
    expect(info?.card.核心结论).toBe('更新后的结论')
    // An unchanged re-run skips the wrapped card via the checkpoint.
    const third = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    expect(third).toEqual({ imported: [], skipped: 1, skippedRaw: 0 })
  })

  it('sequences wrapped card ids and honors an explicit 有效期 horizon', async () => {
    const { store, sourceDir } = await makeWorkspace()
    await writeFile(join(sourceDir, 'a.md'), '# A\n甲\n', 'utf8')
    await writeFile(join(sourceDir, 'b.md'), '# B\n乙\n', 'utf8')
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2', cardTtlDays: 30 })
    const now = new Date()
    const dateKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    expect([...result.imported].sort()).toEqual([`howto-${dateKey}-001` as Card['id'], `howto-${dateKey}-002` as Card['id']].sort())
    const info = await store.find(`howto-${dateKey}-002` as Card['id'])
    const expected = new Date()
    expected.setDate(expected.getDate() + 30)
    const expectedKey = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`
    expect(info?.card.有效期).toBe(expectedKey)
  })

  it('truncates the conclusion and the condition to their caps', async () => {
    const { store, sourceDir } = await makeWorkspace()
    const longLine = '字'.repeat(300)
    const body = '长'.repeat(1500)
    await writeFile(join(sourceDir, 'long.md'), `# 长文\n${longLine}\n${body}\n`, 'utf8')
    const result = await importDir(store, { root: store.root, sourceDir, tier: 'P2' })
    const card = (await store.find(result.imported[0]!))!.card
    expect(card.适用条件).toBe(longLine.slice(0, 200))
    expect(card.核心结论.length).toBe(1000)
    expect(card.核心结论).toBe(`${longLine}\n${body.slice(0, 699)}`)
  })
})
