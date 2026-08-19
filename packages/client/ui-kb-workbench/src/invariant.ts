/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-kb-workbench`.
 * @module @deepseek-ai/dsh-client-ui-kb-workbench/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-kb-workbench'

/** Cordis companion plugin name. */
export const name = 'client-ui-kb-workbench-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a read-only presentation of the
 * `kbWorkbench` Remote namespace onto one settings section entry; every
 * mutation rides the host's `ctx.kb` semantics and the kb-core companion
 * validates the resulting `kb/*` events. It emits no cordis events of its own.
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
