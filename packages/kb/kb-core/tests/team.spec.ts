// Team library storage unit coverage: work-tree construction guard, cards/
// listing (sync + async), find/write (exclusive create)/rewrite/remove, the
// docs/ wiki layer (list + read with the escape guard), and the GitRunner's
// work-tree assertion, status, stage, commit, and log over an injected git
// executable.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitRunner } from '../src/gitops.ts'
import { TeamCardStore } from '../src/team.ts'
import type { Card } from '../src/types.ts'

let roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const TEAM_CARD: Card = {
  id: 'rule-20260818-001' as Card['id'],
  type: 'rule',
  title: '告警处置标准',
  库: 'team',
  状态: 'pending',
  适用条件: '值班收到告警',
  核心结论: '先确认影响面。',
  应做: ['确认影响面'],
  不应做: ['直接重启'],
  来源: 'MR#42',
  责任人: '张三',
  有效期: '2026-12-31',
  标签: ['告警'],
}

/** A minimal card file text for hand-seeded team libraries. */
const CARD_TEXT = `---
id: rule-20260818-001
type: rule
title: 告警处置标准
库: team
状态: pending
适用条件: 值班收到告警
来源: MR#42
责任人: 张三
有效期: 2026-12-31
标签:
  - 告警
---

## 核心结论

先确认影响面。

## 应做

- 确认影响面

## 不应做

- 直接重启
`

describe('TeamCardStore', () => {
  it('fails loud when the root is not a git work tree', async () => {
    const root = await tempDir('dsh-kb-team-plain-')
    expect(() => new TeamCardStore(root)).toThrow(/not a git work tree/)
  })

  it('accepts a git work tree (a .git entry) even before any cards exist', async () => {
    const root = await tempDir('dsh-kb-team-empty-')
    await mkdir(join(root, '.git'))
    const store = new TeamCardStore(root)
    expect(await store.list()).toEqual({ cards: [], failures: [] })
    expect(store.listSync()).toEqual({ cards: [], failures: [] })
  })

  it('lists parsed cards and reports per-file parse failures', async () => {
    const root = await tempDir('dsh-kb-team-list-')
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'cards'))
    await writeFile(join(root, 'cards', 'rule-20260818-001.md'), CARD_TEXT, 'utf8')
    await writeFile(join(root, 'cards', 'broken.md'), 'not a card', 'utf8')
    await writeFile(join(root, 'cards', 'notes.txt'), 'ignored', 'utf8')
    const store = new TeamCardStore(root)
    const listed = await store.list()
    expect(listed.cards).toHaveLength(1)
    expect(listed.cards[0]!.card.id).toBe('rule-20260818-001')
    expect(listed.cards[0]!.card.库).toBe('team')
    expect(listed.failures.map(f => f.path)).toEqual([join(root, 'cards', 'broken.md')])
    const synced = store.listSync()
    expect(synced.cards.map(info => info.card.id)).toEqual(['rule-20260818-001'])
    expect(synced.failures).toHaveLength(1)
  })

  it('find returns the card or undefined, and write/rewrite/remove round-trip', async () => {
    const root = await tempDir('dsh-kb-team-rw-')
    await mkdir(join(root, '.git'))
    const store = new TeamCardStore(root)
    expect(await store.find(TEAM_CARD.id)).toBeUndefined()
    const path = await store.write(TEAM_CARD)
    expect(path).toBe(join(root, 'cards', `${TEAM_CARD.id}.md`))
    expect((await store.find(TEAM_CARD.id))?.card.状态).toBe('pending')
    const revived = { ...TEAM_CARD, 状态: 'ready' as const }
    await store.rewrite(revived)
    expect((await store.find(TEAM_CARD.id))?.card.状态).toBe('ready')
    await store.remove(TEAM_CARD.id)
    expect(await store.find(TEAM_CARD.id)).toBeUndefined()
  })

  it('write fails loud on a non-EEXIST open error (id escaping the cards dir)', async () => {
    const root = await tempDir('dsh-kb-team-open-')
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'cards'))
    await writeFile(join(root, 'cards', 'a'), 'file', 'utf8')
    const store = new TeamCardStore(root)
    await expect(store.write({ ...TEAM_CARD, id: 'a/b' as Card['id'] })).rejects.toThrow()
  })

  it('write fails loud on an existing id (the same-id race boundary)', async () => {
    const root = await tempDir('dsh-kb-team-race-')
    await mkdir(join(root, '.git'))
    const store = new TeamCardStore(root)
    await store.write(TEAM_CARD)
    await expect(store.write(TEAM_CARD)).rejects.toThrow(/already exists/)
  })

  it('lists docs recursively and reads them, refusing paths that escape docs/', async () => {
    const root = await tempDir('dsh-kb-team-docs-')
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'docs', '新人专区'), { recursive: true })
    await writeFile(join(root, 'docs', 'architecture.md'), '# 架构说明', 'utf8')
    await writeFile(join(root, 'docs', '新人专区', 'onboarding.md'), '# 新人指南', 'utf8')
    await writeFile(join(root, 'docs', 'notes.txt'), 'ignored', 'utf8')
    const store = new TeamCardStore(root)
    expect(await store.listDocs()).toEqual([join('docs', 'architecture.md'), join('docs', '新人专区', 'onboarding.md')])
    expect(await store.readDoc(join('docs', 'architecture.md'))).toBe('# 架构说明')
    await expect(store.readDoc('cards/rule-20260818-001.md')).rejects.toThrow(/stay inside docs/)
    await expect(store.readDoc('../secret.md')).rejects.toThrow(/stay inside docs/)
  })

  it('fails loud when cards/ is not a directory and when a card path is a directory', async () => {
    const root = await tempDir('dsh-kb-team-fs-')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, 'cards'), 'not a dir', 'utf8')
    const store = new TeamCardStore(root)
    await expect(store.list()).rejects.toThrow()
    await expect(store.write(TEAM_CARD)).rejects.toThrow()
    expect(() => store.listSync()).toThrow()
    const root2 = await tempDir('dsh-kb-team-fs2-')
    await mkdir(join(root2, '.git'))
    await mkdir(join(root2, 'cards', `${TEAM_CARD.id}.md`), { recursive: true })
    const store2 = new TeamCardStore(root2)
    // A card path that is a directory fails the read (EISDIR), not ENOENT.
    await expect(store2.find(TEAM_CARD.id)).rejects.toThrow()
  })

  it('lists an empty docs/ as no documents and fails loud when docs/ is a file', async () => {
    const root = await tempDir('dsh-kb-team-docs2-')
    await mkdir(join(root, '.git'))
    const store = new TeamCardStore(root)
    expect(await store.listDocs()).toEqual([])
    await writeFile(join(root, 'docs'), 'not a dir', 'utf8')
    await expect(store.listDocs()).rejects.toThrow()
  })
})

describe('GitRunner', () => {
  it('assertWorkTree accepts and rejects based on the rev-parse output', async () => {
    const root = await tempDir('dsh-kb-git-ok-')
    const ok = new GitRunner(root, async (args) => {
      expect(args).toEqual(['rev-parse', '--is-inside-work-tree'])
      return { stdout: 'true\n', stderr: '' }
    })
    await ok.assertWorkTree()
    const bad = new GitRunner(root, async () => ({ stdout: 'false\n', stderr: '' }))
    await expect(bad.assertWorkTree()).rejects.toThrow(/not a git work tree/)
    const throwing = new GitRunner(root, async () => { throw new Error('git rev-parse failed: not a repository') })
    await expect(throwing.assertWorkTree()).rejects.toThrow(/failed/)
  })

  it('status parses porcelain lines and drops empty ones', async () => {
    const runner = new GitRunner('/repo', async (args) => {
      expect(args).toEqual(['status', '--porcelain'])
      return { stdout: ` M cards/rule-1.md\n?? ${join('docs', 'onboarding.md')}\n\n`, stderr: '' }
    })
    expect(await runner.status()).toEqual([' M cards/rule-1.md', `?? ${join('docs', 'onboarding.md')}`])
  })

  it('stage adds the whole tree and commit forwards the message', async () => {
    const calls: string[][] = []
    const runner = new GitRunner('/repo', async (args) => {
      calls.push([...args])
      if (args[0] === 'commit') return { stdout: '[main abc1234] 晋升卡片\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    await runner.stage()
    await runner.commit('晋升卡片 rule-1')
    expect(calls).toEqual([['add', '-A'], ['commit', '-m', '晋升卡片 rule-1']])
  })

  it('commit failures throw with the git stderr', async () => {
    const runner = new GitRunner('/repo', async () => {
      throw new Error('git commit -m x failed: nothing to commit, working tree clean')
    })
    await expect(runner.commit('x')).rejects.toThrow(/nothing to commit/)
  })

  it('log returns the oneline subjects', async () => {
    const runner = new GitRunner('/repo', async (args) => {
      expect(args).toEqual(['log', '-n 2', '--oneline'])
      return { stdout: 'abc1234 晋升卡片\nabc1233 首次提交\n', stderr: '' }
    })
    expect(await runner.log(2)).toEqual(['abc1234 晋升卡片', 'abc1233 首次提交'])
  })

  it('default exec surfaces git stderr on failure and the error message when stderr is empty', async () => {
    const plain = await tempDir('dsh-kb-git-real-')
    const runner = new GitRunner(plain)
    await expect(runner.status()).rejects.toThrow(/git status --porcelain failed/)
    const missing = new GitRunner('/no/such/dir/dsh-kb-git-missing')
    await expect(missing.status()).rejects.toThrow(/git status --porcelain failed/)
  })
})
