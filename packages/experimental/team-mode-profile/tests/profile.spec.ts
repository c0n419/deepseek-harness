/** The Team mode bundle must add one isolated `team` preset and leave other presets alone. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface Entry {
  id?: string
  name?: string
  disabled?: unknown
  isolate?: Record<string, boolean>
  config?: Record<string, unknown> | Entry[]
  insert?: Entry[]
}

const root = fileURLToPath(new URL('..', import.meta.url))

function load(path: string): Entry[] {
  return yaml.load(readFileSync(resolve(root, path), 'utf8'), { schema: entryListSchema }) as Entry[]
}

function preset(patches: Entry[], id: string): { config: { id: string; order: number; plugins: Entry[] } } {
  const row = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === id)
  if (row === undefined) throw new Error(`missing ${id}`)
  return row as { config: { id: string; order: number; plugins: Entry[] } }
}

describe('Team mode profile bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    publishConfig?: { access?: string }
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }
  const patches = load(manifest.dsh!.bundle!.patch!)

  it('is a public bundle that inserts only rows of its own', () => {
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-agent-team': 'workspace:*',
      '@deepseek-ai/dsh-experimental-client-ui-agent-team': 'workspace:*',
      '@deepseek-ai/dsh-experimental-llm-acp': 'workspace:*',
      '@deepseek-ai/dsh-experimental-tool-agent-team': 'workspace:*',
    })
    expect(patches.every(patch => patch.insert !== undefined)).toBe(true)
    expect(patches.flatMap(patch => patch.insert ?? []).map(entry => entry.id)).toEqual(['ui-team-mode', 'llm-acp', 'preset-team'])
  })

  it('replaces Standard delegation with an isolated Team group and mounts the external route once', () => {
    const team = preset(patches, 'preset-team').config
    expect(team).toMatchObject({ id: 'team', order: 5 })
    const ids = team.plugins.map(plugin => plugin.id)
    expect(ids).not.toContain('delegation')
    const group = team.plugins.find(plugin => plugin.id === 'team')!
    expect(group).toMatchObject({ name: 'cordis:group', isolate: { agentTeams: true } })
    const rows = group.config as Entry[]
    expect(rows.find(row => row.id === 'tool-agent-team')).toMatchObject({ config: { externalProvider: 'acp' } })
    expect(rows.map(row => row.id)).toEqual(['agent-team', 'tool-agent-team'])
    const route = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'llm-acp')!
    expect(route).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-llm-acp',
      config: { provider: 'acp', permission: 'allow', isolation: 'worktree' },
    })
    const harnesses = (route.config as { harnesses: Record<string, { args: string[] }> }).harnesses
    expect(Object.keys(harnesses)).toEqual(['claude', 'codex', 'opencode', 'omp', 'gemini', 'pi'])
    for (const harness of Object.values(harnesses)) {
      const pkg = harness.args.find(arg => arg.startsWith('@') || arg.startsWith('pi-acp'))
      if (pkg !== undefined) expect(pkg).toMatch(/@\d+\.\d+\.\d+$/)
    }
  })

  it('keeps every other Standard plugin row', () => {
    const standard = preset(load('../../bundle/web-app/presets/standard.patch.yml'), 'preset-standard').config
    const team = preset(patches, 'preset-team').config
    const others = (plugins: Entry[], skip: string) => plugins.filter(plugin => plugin.id !== skip)
    expect(others(team.plugins, 'team')).toEqual(others(standard.plugins, 'delegation'))
  })
})
