/** The Herdr panel's registration: the Remote mount, the shared view store, the rail entry, and the retry restart. */

import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { HerdrPaneId } from '@deepseek-ai/dsh-experimental-herdr'
import type {
  HerdrCommandResult, HerdrKey, HerdrReadResult, HerdrView,
} from '@deepseek-ai/dsh-experimental-herdr/types'
import {
  RemoteError, type RemoteResult, type RemoteStreamHandle, type TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { HerdrPanel, type HerdrPanelInjected } from '../src/client/HerdrPanel.tsx'
import { HerdrPanelIcon } from '../src/client/HerdrPanelIcon.tsx'
import { inject, mountHerdrPanel, PANEL_ID } from '../src/client/mount.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-herdr', descriptors: [] }

/**
 * The `remote.herdr` namespace as the plugin's generated client declares it,
 * narrowed to the members this spec drives. Tests swap one face on this object
 * after the mount already captured the namespace instance.
 */
interface HerdrNamespace {
  watch: (signal?: AbortSignal) => RemoteStreamHandle<HerdrView, never>
  read: (paneId: HerdrPaneId) => Promise<RemoteResult<HerdrReadResult>>
  prompt: (paneId: HerdrPaneId, text: string) => Promise<RemoteResult<HerdrCommandResult>>
  sendKeys: (paneId: HerdrPaneId, keys: readonly HerdrKey[]) => Promise<RemoteResult<HerdrCommandResult>>
  sendText: (paneId: HerdrPaneId, text: string) => Promise<RemoteResult<HerdrCommandResult>>
  focus: (paneId: HerdrPaneId) => Promise<RemoteResult<HerdrCommandResult>>
}

/** A view the fake watch stream pushes. */
const view: HerdrView = {
  connection: { status: 'connected', version: '0.8.2', protocol: 20 },
  outputRefreshMs: 60_000,
  workspaces: [], tabs: [], panes: [], agents: [],
}

/** Narrow the erased registry payload before exercising the panel's injected face. */
function assertPanelInjected(value: Record<string, unknown>): asserts value is Record<string, unknown> & HerdrPanelInjected {
  assert(typeof value.read === 'function')
  assert(typeof value.prompt === 'function')
  assert(typeof value.sendKeys === 'function')
  assert(typeof value.sendText === 'function')
  assert(typeof value.focus === 'function')
  assert(typeof value.restart === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

/** A fake `watch` stream handle the test feeds by hand; disposal is observable. */
interface FakeStream extends RemoteStreamHandle<HerdrView, never> {
  /** How many times the consumer disposed this stream. */
  readonly disposeCalls: () => number
  /** Queue one view for the consumer. */
  push(frame: HerdrView): void
  /** Reject the consumer with a failure. */
  fail(error: unknown): void
  /** End the consumer cleanly, as the Host does on a terminal state. */
  close(): void
}

/** Build one hand-fed `watch` stream handle. */
function stream(): FakeStream {
  const queue: HerdrView[] = []
  let wake: (() => void) | undefined
  let closed = false
  let failure: unknown
  let disposals = 0
  const handle: FakeStream = {
    disposeCalls: () => disposals,
    push(frame: HerdrView) { queue.push(frame); wake?.() },
    fail(error: unknown) { failure = error; wake?.() },
    close() { closed = true; wake?.() },
    send() {},
    end() {},
    dispose() { disposals += 1; closed = true; wake?.() },
    async *[Symbol.asyncIterator](): AsyncIterator<HerdrView> {
      while (true) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        if (failure !== undefined) throw failure
        if (closed) return
        const parked = Promise.withResolvers<null>()
        wake = () => { parked.resolve(null) }
        await parked.promise
        wake = undefined
      }
    },
  }
  return handle
}

/** Assemble the browser plugin over a fake Remote namespace and slot registry. */
async function fixture() {
  const ctx = new Context()
  // `remote.herdr` is the generated namespace's runtime name; the source tree
  // has no built `/remote` entry, so the fake service stands in for it.
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const streams: FakeStream[] = []
  // The generated namespace returns `RemoteResult` wrappers; the panel unwraps
  // them, so the fake must wrap in the same envelope.
  const read = vi.fn<HerdrNamespace['read']>(async () => ({
    ok: true,
    value: { paneId: HerdrPaneId('w1:p1'), text: 'out', cols: 80, revision: 1, truncated: false },
  }))
  const refused = (): RemoteResult<HerdrCommandResult> => ({
    ok: false,
    error: new RemoteError('gateway/bad-request', 'refused', {}),
  })
  // One mock per method signature: each generated method has its own parameters,
  // so a shared instance cannot satisfy all three without a cast.
  const prompt = vi.fn<HerdrNamespace['prompt']>(async () => refused())
  const sendKeys = vi.fn<HerdrNamespace['sendKeys']>(async () => refused())
  const sendText = vi.fn<HerdrNamespace['sendText']>(async () => refused())
  const focus = vi.fn<HerdrNamespace['focus']>(async () => refused())
  // The namespace object stays the same instance the plugin reads, so a test
  // can swap one command face after the mount already captured the namespace.
  const namespace: HerdrNamespace = {
    watch: vi.fn((_signal?: AbortSignal) => {
      const handle = stream()
      streams.push(handle)
      return handle
    }),
    read,
    prompt,
    sendKeys,
    sendText,
    focus,
  }
  ctx.provide('remote.herdr', namespace)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const warn = vi.fn()
  ctx.logger.warn = warn as never
  await ctx.plugin(SlotRegistry)
  // The frame declares the two seats this plugin fills; ui-layout and
  // ui-sidebar own them in the shipped Web composition.
  ctx.slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  let dispose: (() => Promise<void>) | undefined
  const fiber = ctx.plugin({
    inject: [...inject],
    apply: async (plugin: Context) => { dispose = await mountHerdrPanel(plugin, REMOTE) },
  })
  await fiber
  const entry = ctx.slots.entries('main').find(candidate => candidate.component === HerdrPanel)
  const rail = ctx.slots.entries('sidebar.panellist').find(candidate => candidate.component === HerdrPanelIcon)
  if (entry === undefined || rail === undefined || dispose === undefined) {
    throw new Error('the panel registered no main entry or rail entry')
  }
  const injectFace = entry.inject
  if (injectFace === undefined) throw new Error('the main entry injects nothing')
  const injected = (): HerdrPanelInjected => {
    const value: Record<string, unknown> = injectFace()
    assertPanelInjected(value)
    return value
  }
  return { ctx, dispose, unmount, streams, namespace, read, commands: { prompt, sendKeys, sendText, focus }, warn, injected, entry, rail }
}

it('exposes the host marker, the browser inject list, and the rail id', () => {
  hostApply()
  expect(inject).toEqual(['remote', 'slots', 'locale'])
  expect(PANEL_ID).toBe('herdr')
})

it('registers the keyed main panel and the matching rail entry, and withdraws both on dispose', async () => {
  const f = await fixture()
  expect(f.entry?.options).toMatchObject({ key: 'herdr' })
  expect(f.entry?.locale).toBe('herdr')
  expect(f.rail?.options).toMatchObject({ id: 'herdr' })
  const t = f.ctx.locale.bind('herdr')
  expect(t('title')).toBe('Herdr')
  await f.dispose()
  expect(f.ctx.slots.entries('main')).toHaveLength(0)
  expect(f.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
  expect(f.unmount).toHaveBeenCalled()
  expect(t('title')).toBe('title')
})

it('feeds every pushed view into the panel store without any user action', async () => {
  const f = await fixture()
  const panel = f.injected()
  const seen: (HerdrView | undefined)[] = []
  const unsubscribe = panel.hooks.view.subscribe(() => { seen.push(panel.hooks.view.getSnapshot()) })
  expect(panel.hooks.view.getSnapshot()).toBeUndefined()
  expect(f.namespace.watch).toHaveBeenCalledTimes(1)
  const handle = f.streams[0]
  if (handle === undefined) throw new Error('no stream')
  handle.push(view)
  await vi.waitFor(() => { expect(seen).toEqual([view]) })
  unsubscribe()
  await f.dispose()
  expect(handle.disposeCalls()).toBe(1)
  expect(f.warn).not.toHaveBeenCalled()
})

it('restarts the stream over the same store so subscribers keep their identity', async () => {
  const f = await fixture()
  const panel = f.injected()
  const store = panel.hooks.view
  const seen: (HerdrView | undefined)[] = []
  store.subscribe(() => { seen.push(store.getSnapshot()) })
  panel.restart()
  expect(f.namespace.watch).toHaveBeenCalledTimes(2)
  expect(f.streams[0]?.disposeCalls()).toBe(1)
  expect(panel.hooks.view).toBe(store)
  const next = f.streams[1]
  if (next === undefined) throw new Error('no restarted stream')
  next.push(view)
  await vi.waitFor(() => { expect(seen).toEqual([view]) })
  await f.dispose()
})

it('logs a stream that fails while watched, in either thrown form', async () => {
  const f = await fixture()
  const handle = f.streams[0]
  if (handle === undefined) throw new Error('no stream')
  handle.fail(new Error('connection lost'))
  await vi.waitFor(() => {
    expect(f.warn).toHaveBeenCalledWith('client-ui-herdr: view stream ended: connection lost')
  })
  f.injected().restart()
  const second = f.streams[1]
  if (second === undefined) throw new Error('no restarted stream')
  // A non-Error rejection still produces a diagnostic rather than "[object Object]".
  second.fail('plain failure')
  await vi.waitFor(() => {
    expect(f.warn).toHaveBeenCalledWith('client-ui-herdr: view stream ended: plain failure')
  })
  expect(f.warn).toHaveBeenCalledTimes(2)
  await f.dispose()
})

it('reports nothing when a stream fails after its watch was disposed', async () => {
  const f = await fixture()
  const panel = f.injected()
  const handle = f.streams[0]
  if (handle === undefined) throw new Error('no stream')
  // Both the disposal and the failure land before the reader resumes, so the
  // rejection is the closed stream settling, not a diagnostic to report.
  panel.restart()
  handle.fail(new Error('closed by teardown'))
  const settled = Promise.withResolvers<undefined>()
  setTimeout(settled.resolve, 0)
  await settled.promise
  expect(f.warn).not.toHaveBeenCalled()
  await f.dispose()
})

it('surfaces a refused read as a throw', async () => {
  const f = await fixture()
  f.read.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'read refused', {}) })
  await expect(f.injected().read(HerdrPaneId('w1:p1'))).rejects.toThrow('read refused')
  await f.dispose()
})

it('names the rail entry from the bound translate, re-read on every call', async () => {
  const f = await fixture()
  const label = f.rail?.options.label as (() => string) | undefined
  expect(label?.()).toBe('Herdr')
  await f.dispose()
  expect(label?.()).toBe('panel')
})

it('unwraps the read result and surfaces every refused command as a throw', async () => {
  const f = await fixture()
  const panel = f.injected()
  expect(await panel.read(HerdrPaneId('w1:p1'))).toMatchObject({ text: 'out' })
  expect(f.read).toHaveBeenCalledWith(HerdrPaneId('w1:p1'))
  await expect(panel.prompt(HerdrPaneId('w1:p1'), 'go')).rejects.toThrow('refused')
  await expect(panel.sendKeys(HerdrPaneId('w1:p1'), ['esc'])).rejects.toThrow('refused')
  await expect(panel.sendText(HerdrPaneId('w1:p1'), 'ls\r')).rejects.toThrow('refused')
  await expect(panel.focus(HerdrPaneId('w1:p1'))).rejects.toThrow('refused')
  expect(f.commands.prompt).toHaveBeenCalledWith(HerdrPaneId('w1:p1'), 'go')
  expect(f.commands.sendKeys).toHaveBeenCalledWith(HerdrPaneId('w1:p1'), ['esc'])
  expect(f.commands.sendText).toHaveBeenCalledWith(HerdrPaneId('w1:p1'), 'ls\r')
  expect(f.commands.focus).toHaveBeenCalledWith(HerdrPaneId('w1:p1'))
  await f.dispose()
})

it('returns the accepted command result when the server accepts it', async () => {
  const f = await fixture()
  const panel = f.injected()
  const accepted = (): RemoteResult<HerdrCommandResult> => ({ ok: true, value: { ok: true } })
  f.namespace.prompt = vi.fn<HerdrNamespace['prompt']>(async () => accepted())
  f.namespace.sendKeys = vi.fn<HerdrNamespace['sendKeys']>(async () => accepted())
  f.namespace.sendText = vi.fn<HerdrNamespace['sendText']>(async () => accepted())
  f.namespace.focus = vi.fn<HerdrNamespace['focus']>(async () => accepted())
  expect(await panel.prompt(HerdrPaneId('w1:p1'), 'go')).toEqual({ ok: true })
  expect(await panel.sendKeys(HerdrPaneId('w1:p1'), ['esc'])).toEqual({ ok: true })
  expect(await panel.sendText(HerdrPaneId('w1:p1'), 'ls\r')).toEqual({ ok: true })
  expect(await panel.focus(HerdrPaneId('w1:p1'))).toEqual({ ok: true })
  await f.dispose()
})

it('returns the absent-pane read result without throwing', async () => {
  const f = await fixture()
  f.read.mockResolvedValueOnce({ ok: true, value: { notFound: true } })
  expect(await f.injected().read(HerdrPaneId('w1:p1'))).toEqual({ notFound: true })
  await f.dispose()
})

it('withdraws the Remote mount when the registration fails', async () => {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount() { return unmount }
  }
  new Remote()
  ctx.provide('remote.herdr', { watch: vi.fn(), read: vi.fn(), prompt: vi.fn(), sendKeys: vi.fn(), focus: vi.fn() })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  const fiber = ctx.plugin({ inject: [...inject], apply: (plugin: Context) => mountHerdrPanel(plugin, REMOTE) })
  await expect(fiber).rejects.toThrow('slot failed')
  expect(unmount).toHaveBeenCalled()
})
