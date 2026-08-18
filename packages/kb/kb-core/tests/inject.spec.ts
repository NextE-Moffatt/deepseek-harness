// Injection wiring unit coverage: the session-start trigger's failure paths —
// a pack append that throws is contained per pack, and the library read
// failure is contained per session. The happy path and the once-per-session
// guard live in the loader-composition and agent-loop integration suites.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { injectPacks } from '@deepseek-ai/dsh-kb-core'
import type { KbService } from '../src/index.ts'

let roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

/** A workspace with one card matching the pack's tag. */
async function libraryWithCard(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kb-inject-'))
  roots.push(root)
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'kb/cards/P2'), { recursive: true })
  await writeFile(join(root, 'kb/cards/P2/rule-20260818-001.md'), `---
id: rule-20260818-001
type: rule
title: 告警处置标准
库: personal
状态: draft
适用条件: 值班收到告警
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
`, 'utf8')
  return root
}

/** A fake agent whose session append fails, hitting the per-pack containment. */
function throwingAgent(cwd: string): Agent {
  return {
    id: 'throwing-agent',
    options: {},
    session: {
      header: { cwd },
      events: [],
      append: () => { throw new Error('append failed') },
    },
  } as unknown as Agent
}

describe('injectPacks failure containment', () => {
  it('contains a pack append failure and still injects the next pack', async () => {
    const ctx = new Context()
    const root = await libraryWithCard()
    const kb = {
      config: {
        packs: [
          { name: '告警处置', tags: ['告警'] },
          { name: '告警处置2', tags: ['告警'] },
        ],
        cardsPath: 'kb/cards',
      },
    } as unknown as KbService
    let failures = 0
    const agent = {
      id: 'x',
      session: {
        header: { cwd: root },
        events: [],
        append: () => {
          failures += 1
          if (failures === 1) throw new Error('append failed')
          return { seq: failures }
        },
      },
    } as unknown as Agent
    injectPacks(ctx, kb, agent)
    // The first append threw and was contained; the second pack appended.
    expect(failures).toBe(2)
  })

  it('contains a throwing append without other packs', async () => {
    const ctx = new Context()
    const root = await libraryWithCard()
    const kb = {
      config: {
        packs: [{ name: '告警处置', tags: ['告警'] }],
        cardsPath: 'kb/cards',
      },
    } as unknown as KbService
    const agent = throwingAgent(root)
    expect(() => { injectPacks(ctx, kb, agent) }).not.toThrow()
  })
})
