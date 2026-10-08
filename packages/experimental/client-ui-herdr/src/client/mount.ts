/** Source-safe Herdr browser registration: the Remote mount, the view store, the rail entry, and the main panel. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the generated `TypertRemoteNamespaceMap` merge that gives
// `ctx.remote.herdr` its methods. The runtime value comes from `./index.ts`.
import type {} from '@deepseek-ai/dsh-experimental-herdr/remote'
import type { HerdrReadResult, HerdrView } from '@deepseek-ai/dsh-experimental-herdr/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { HerdrPanel, type HerdrPanelInjected } from './HerdrPanel.tsx'
import { HerdrPanelIcon } from './HerdrPanelIcon.tsx'
import { en, NS, zh, type HerdrKey } from './locales.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Herdr panel copy. */
    herdr: HerdrKey
  }
}

/** Required browser services: the Remote namespace, slots, and localized copy. */
export const inject = ['remote', 'slots', 'locale']

/** The rail entry id, which is also the keyed main-panel key. */
export const PANEL_ID = 'herdr' as MainPanelId

/** Describe one thrown value for the panel's error line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One live view stream and the store it feeds. */
interface Watch {
  /** Abort the stream and release its handle. */
  dispose(): void
}

/**
 * Open one view stream into an existing store. The Host closes the stream on a
 * terminal connection state; Retry disposes the settled watch and opens a fresh
 * one over the same store, so subscribers keep their identity.
 * @param ctx - browser Context with the mounted `remote.herdr` namespace.
 * @param store - store receiving every pushed view.
 * @returns the watch.
 */
function openWatch(ctx: Context, store: SnapshotStore<HerdrView | undefined>): Watch {
  const controller = new AbortController()
  const handle = ctx.remote.herdr.watch(controller.signal)
  void (async () => {
    try {
      for await (const view of handle) store.set(view)
    } catch (error: unknown) {
      if (!controller.signal.aborted) ctx.logger.warn(`client-ui-herdr: view stream ended: ${messageOf(error)}`)
    }
  })()
  return {
    dispose: () => {
      controller.abort()
      handle.dispose()
    },
  }
}

/** The registrations the mounted namespace enables. */
function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-herdr: dictionaries')
  const store = createSnapshotStore<HerdrView | undefined>(undefined)
  let watch = openWatch(ctx, store)
  ctx.effect(() => () => { watch.dispose() }, 'client-ui-herdr: view stream')
  const injected = (): HerdrPanelInjected => ({
    hooks: { view: store },
    read: async (paneId) => {
      const result = await ctx.remote.herdr.read(paneId)
      if (!result.ok) throw result.error
      return result.value satisfies HerdrReadResult
    },
    prompt: async (paneId, text) => {
      const result = await ctx.remote.herdr.prompt(paneId, text)
      if (!result.ok) throw result.error
      return result.value
    },
    sendKeys: async (paneId, keys) => {
      const result = await ctx.remote.herdr.sendKeys(paneId, keys)
      if (!result.ok) throw result.error
      return result.value
    },
    sendText: async (paneId, text) => {
      const result = await ctx.remote.herdr.sendText(paneId, text)
      if (!result.ok) throw result.error
      return result.value
    },
    focus: async (paneId) => {
      const result = await ctx.remote.herdr.focus(paneId)
      if (!result.ok) throw result.error
      return result.value
    },
    restart: () => {
      watch.dispose()
      watch = openWatch(ctx, store)
    },
  })
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: injected,
  }, HerdrPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    locale: NS,
    label: () => t('panel'),
  }, HerdrPanelIcon))
}

/**
 * Mount the Herdr Remote contribution and register the rail entry and panel.
 * @param ctx - browser Context with `remote`, `slots`, and `locale`.
 * @param contribution - the generated `herdr` Remote contribution.
 * @returns the disposer that withdraws the registrations and the Remote mount.
 */
export async function mountHerdrPanel(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.herdr', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
