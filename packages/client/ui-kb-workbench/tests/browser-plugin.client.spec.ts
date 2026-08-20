/**
 * ui-kb-workbench plugin halves: the browser entry's dictionary and
 * settings-section registration against the real SlotRegistry (with fiber
 * teardown proving removal — HMR safety), the inert node entry, and the
 * invariant companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as WorkbenchInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Slot ledger reader: entry ids currently registered in the section list. */
function sectionEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('settings.section')
    .map(entry => entry.options.id)
}

/** Boot the browser half over a real slot tree that declares the section list. */
async function bench(kbWorkbench: Record<string, unknown> = {}): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('sessions', {})
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { kbWorkbench, $on: () => () => {} } as never)
  ctx.provide('remote.kbWorkbench', kbWorkbench as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-kb-workbench browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.kbWorkbench'])
  })

  it('registers the settings section, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(sectionEntryIds(ctx)).toContain('kb-workbench')
    await fiber.dispose()
    expect(sectionEntryIds(ctx)).not.toContain('kb-workbench')
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    ctx.locale.setLocale('zh')
    expect(translate('nav')).toBe(zh['nav'])
    ctx.locale.setLocale('en')
    expect(translate('nav')).toBe(en['nav'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('nav')).not.toBe(en['nav'])
  })

  it('binds the inject face to the kbWorkbench remote namespace', async () => {
    const kbWorkbench = {
      overview: vi.fn(async () => ({ ok: true as const, value: {} })),
      card: vi.fn(async () => ({ ok: true as const, value: {} })),
      promote: vi.fn(async () => ({ ok: true as const, value: {} })),
      archive: vi.fn(async () => ({ ok: true as const, value: {} })),
      revive: vi.fn(async () => ({ ok: true as const, value: {} })),
      review: vi.fn(async () => ({ ok: true as const, value: {} })),
      edit: vi.fn(async () => ({ ok: true as const, value: {} })),
      listDocs: vi.fn(async () => ({ ok: true as const, value: [] })),
      readDoc: vi.fn(async () => ({ ok: true as const, value: {} })),
      writeDoc: vi.fn(async () => ({ ok: true as const, value: {} })),
      removeDoc: vi.fn(async () => ({ ok: true as const, value: {} })),
    }
    const { ctx } = await bench(kbWorkbench)
    const entry = ctx.slots.entries('settings.section').find(candidate => candidate.options.id === 'kb-workbench')
    expect(entry).toBeDefined()
    // The nav label thunk follows the active locale.
    ctx.locale.setLocale('zh')
    expect(resolveSlotLabel(entry!.options.label)).toBe(zh['nav'])
    ctx.locale.setLocale('en')
    expect(resolveSlotLabel(entry!.options.label)).toBe(en['nav'])
    const face = entry!.inject!() as {
      overview: (s: string, t?: string) => Promise<unknown>
      card: (s: string, id: string) => Promise<unknown>
      promote: (s: string, id: string, target: string, evidence?: string) => Promise<unknown>
      archive: (s: string, id: string) => Promise<unknown>
      revive: (s: string, id: string) => Promise<unknown>
      review: (s: string, id: string, approved: boolean) => Promise<unknown>
      edit: (s: string, id: string, patch: unknown, options?: unknown) => Promise<unknown>
      listDocs: (s: string) => Promise<unknown>
      readDoc: (s: string, docPath: string) => Promise<unknown>
      writeDoc: (s: string, docPath: string, content: string, options?: unknown) => Promise<unknown>
      removeDoc: (s: string, docPath: string, options?: unknown) => Promise<unknown>
    }
    await face.overview('s1', '2026-08-19')
    expect(kbWorkbench.overview).toHaveBeenCalledWith('s1', '2026-08-19')
    await face.card('s1', 'rule-1')
    expect(kbWorkbench.card).toHaveBeenCalledWith('s1', 'rule-1')
    await face.promote('s1', 'rule-1', 'pending', 'MR#1')
    expect(kbWorkbench.promote).toHaveBeenCalledWith('s1', 'rule-1', 'pending', 'MR#1')
    await face.archive('s1', 'rule-1')
    expect(kbWorkbench.archive).toHaveBeenCalledWith('s1', 'rule-1')
    await face.revive('s1', 'rule-1')
    expect(kbWorkbench.revive).toHaveBeenCalledWith('s1', 'rule-1')
    await face.review('s1', 'rule-1', true)
    expect(kbWorkbench.review).toHaveBeenCalledWith('s1', 'rule-1', true)
    await face.edit('s1', 'rule-1', { title: '新标题' }, { approved: true })
    expect(kbWorkbench.edit).toHaveBeenCalledWith('s1', 'rule-1', { title: '新标题' }, { approved: true })
    await face.listDocs('s1')
    expect(kbWorkbench.listDocs).toHaveBeenCalledWith('s1')
    await face.readDoc('s1', join('docs', 'a.md'))
    expect(kbWorkbench.readDoc).toHaveBeenCalledWith('s1', join('docs', 'a.md'))
    await face.writeDoc('s1', join('docs', 'a.md'), '# 内容', { approved: true })
    expect(kbWorkbench.writeDoc).toHaveBeenCalledWith('s1', join('docs', 'a.md'), '# 内容', { approved: true })
    await face.removeDoc('s1', join('docs', 'a.md'), { approved: true })
    expect(kbWorkbench.removeDoc).toHaveBeenCalledWith('s1', join('docs', 'a.md'), { approved: true })
  })

  it('node half is inert', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('ui-kb-workbench invariant companion', () => {
  it('reserves package ownership and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(WorkbenchInvariant)
    await fiber.await()
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-client-ui-kb-workbench', () => {}))
      .toThrow(/already registered/)
    await fiber.dispose()
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-client-ui-kb-workbench', () => {})).not.toThrow()
  })
})
