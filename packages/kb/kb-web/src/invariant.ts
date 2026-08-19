/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-kb-web`.
 * @module @deepseek-ai/dsh-kb-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-kb-web'

/** Cordis companion plugin name. */
export const name = 'kb-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every `kb/promote` event this service appends is
 * validated against the shared state machine by the `@deepseek-ai/dsh-kb-core`
 * companion (the transition table is kb-core's), and every read-side payload
 * is a projection of kb-core's own derived files (heat ledger, recap
 * checkpoint, card files).
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
