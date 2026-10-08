/** The experimental bundle must carry one parseable, explicit Herdr layer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as entry from '../src/index.ts'

describe('Herdr profile bundle', () => {
  it('declares a public parseable layer with the host and Web rows', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      icon?: string
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-herdr': 'workspace:*',
      '@deepseek-ai/dsh-experimental-client-ui-herdr': 'workspace:*',
    })

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as { insert?: { id?: string; name?: string }[] }[]
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted).toEqual([
      { id: 'herdr', name: '@deepseek-ai/dsh-experimental-herdr' },
      { id: 'ui-herdr', name: '@deepseek-ai/dsh-experimental-client-ui-herdr' },
    ])
  })

  it('keeps the module entry inert', () => {
    expect('default' in entry).toBe(false)
    expect(Object.keys(entry)).toEqual([])
  })
})
