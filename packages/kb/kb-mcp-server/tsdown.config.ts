import { defineConfig } from 'tsdown'

/**
 * kb-mcp-server ships TWO entries: the plugin (`index` + `invariant`) and the
 * `dsh-kb-mcp` CLI bin (`bin`), the latter referenced by package.json
 * `bin`. The root tsdown builds only `lib/types/index.js`, so this override
 * adds `lib/types/bin.js`. Declarations come from `tsc -b` (dts: false),
 * matching every package.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
