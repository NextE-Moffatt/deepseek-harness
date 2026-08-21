/**
 * Manifest-owned knowledge-base Profile Bundle. The package runtime is inert;
 * `dsh.bundle.patch` mounts the knowledge tools and Web workbench plugins.
 * @module @deepseek-ai/dsh-kb
 */

/** Stable Cordis plugin name for direct Loader diagnostics. */
export const name = 'kb-bundle'

/** The bundle has no runtime registration outside its manifest patch. */
export function apply(): void {}
