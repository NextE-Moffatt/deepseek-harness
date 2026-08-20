/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-kb-mcp-server`.
 * @module @deepseek-ai/dsh-kb-mcp-server/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-kb-mcp-server'

/** Cordis companion plugin name. */
export const name = 'kb-mcp-server-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this server is read-only by construction — every tool
 * handler calls a `ctx.kb` read method, emits no cordis events, and mutates
 * no state; each result is a projection of kb-core's own derived files.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
