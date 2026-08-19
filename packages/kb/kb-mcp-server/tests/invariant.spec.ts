/**
 * Companion registration coverage for `@deepseek-ai/dsh-kb-mcp-server`: the
 * invariant installer reserves package ownership under the invariants registry
 * (the empty installer is the documented shape — see src/invariant.ts).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as KbMcpInvariant from '@deepseek-ai/dsh-kb-mcp-server/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  return ctx
}

describe('kb-mcp-server invariant companion', () => {
  it('registers package ownership with the invariants registry', async () => {
    const ctx = await setup()
    await ctx.plugin(KbMcpInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-kb-mcp-server', () => {}))
      .toThrow(/already registered/)
  })

  it('releases ownership when the owning fiber disposes', async () => {
    const ctx = await setup()
    const fiber = ctx.plugin(KbMcpInvariant)
    await fiber
    await fiber.dispose()
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-kb-mcp-server', () => {})).not.toThrow()
  })
})
