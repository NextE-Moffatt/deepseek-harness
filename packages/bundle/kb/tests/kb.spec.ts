/** The bundle manifest and patch are the installable knowledge-base unit. */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-kb bundle', () => {
  it('declares the three knowledge-base roles through a parseable patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    const patch = manifest.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    expect(existsSync(resolve(root, patch!))).toBe(true)
    const parsed = yaml.load(readFileSync(resolve(root, patch!), 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as { insert?: { id?: string; name?: string; config?: Record<string, unknown> }[] }[])
      .flatMap(entry => entry.insert ?? [])
    expect(rows).toEqual([
      { id: 'kb-core', name: '@deepseek-ai/dsh-kb-core', config: { packs: [] } },
      { id: 'kb-web', name: '@deepseek-ai/dsh-kb-web' },
      { id: 'kb-workbench', name: '@deepseek-ai/dsh-client-ui-kb-workbench' },
    ])
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-client-ui-kb-workbench',
      '@deepseek-ai/dsh-kb-core',
      '@deepseek-ai/dsh-kb-web',
    ])
  })
})
