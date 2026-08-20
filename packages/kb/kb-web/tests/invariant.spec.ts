/**
 * Companion registration coverage for `@deepseek-ai/dsh-kb-web`: the invariant
 * installer reserves package ownership under the invariants registry (the
 * empty installer is the documented shape — see src/invariant.ts).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as KbWebInvariant from '@deepseek-ai/dsh-kb-web/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  return ctx
}

describe('kb-web invariant companion', () => {
  it('registers package ownership with the invariants registry', async () => {
    const ctx = await setup()
    await ctx.plugin(KbWebInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-kb-web', () => {}))
      .toThrow(/already registered/)
  })

  it('releases ownership when the owning fiber disposes', async () => {
    const ctx = await setup()
    const fiber = ctx.plugin(KbWebInvariant)
    await fiber
    await fiber.dispose()
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-kb-web', () => {})).not.toThrow()
  })
})
