/** Browser entry: mounts the Herdr Remote and registers the rail entry and panel. */

import type { Context } from '@deepseek-ai/cordis'
import herdrRemote from '@deepseek-ai/dsh-experimental-herdr/remote'
import { mountHerdrPanel } from './mount.ts'

export { inject, PANEL_ID } from './mount.ts'
export type { HerdrPanelInjected, HerdrPanelProps } from './HerdrPanel.tsx'
export type { HerdrKey } from './locales.ts'

/**
 * Register the Herdr panel on the Client Context.
 * @param ctx - Client Context with the declared `inject` services available.
 * @returns the disposer that withdraws the panel and the Remote mount.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountHerdrPanel(ctx, herdrRemote)
}
