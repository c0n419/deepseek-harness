/**
 * Real Loader composition: the host service mounted from a `cordis.yml` row, so
 * the plugin's own `Config` and `apply` shape are exercised through the shipped
 * loader rather than a direct constructor call.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { HerdrPaneId } from '../src/brand.ts'
import { startFakeHerdr } from './fake-herdr.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('loads from a cordis.yml row, takes the row socket path, and serves a view', async () => {
  const server = await startFakeHerdr()
  server.answer({ result: { type: 'session_snapshot', snapshot: {
    workspaces: [{ workspace_id: 'w1', label: 'from-row', focused: true, tab_count: 1, pane_count: 1, agent_status: 'idle' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', focused: true, pane_count: 1, agent_status: 'idle' }],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, agent_status: 'idle', revision: 0 }],
    agents: [],
  } } }, 'session.snapshot')
  try {
    root = await mkdtemp(join(tmpdir(), 'dsh-herdr-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-experimental-herdr'",
      '  config:',
      `    socketPath: ${server.socketPath}`,
      '    readLines: 12',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    // Leave the internal module loader unset so the tree resolves the row through
    // the ordinary dynamic import, which the test's source-plane resolution serves.
    context.loader.internal = undefined
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const { default: HerdrService } = await import('../src/index.ts')
    expect(context.herdr).toBeInstanceOf(HerdrService)
    const controller = new AbortController()
    let connected
    for await (const view of context.herdr.watch(controller.signal)) {
      if (view.connection.status === 'connected') { connected = view; break }
    }
    controller.abort()
    expect(connected?.workspaces[0]?.label).toBe('from-row')
    // The row's config reached the transport, not a module default.
    server.answer(undefined, 'session.snapshot')
    expect(await context.herdr.read(HerdrPaneId('w1:p1'))).toMatchObject({ text: 'read w1:p1' })
    expect(server.requests.at(-1)?.params).toMatchObject({ lines: 12 })
  } finally {
    await server.close()
  }
})

it('is a namespace-free default-export plugin: no `name`/`apply` module exports', async () => {
  const module = await import('../src/index.ts')
  expect('default' in module).toBe(true)
  expect('apply' in module).toBe(false)
  expect('name' in module).toBe(false)
})
