/** Decorative occupant for the Herdr sidebar panel entry. */

import { IconWorkspaceTreeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the workspace-tree glyph at the size the sidebar asks for; the
 * sidebar owns its accessible navigation label.
 * @param props - the sidebar's icon share: the requested edge and selection.
 * @returns decorative workspace tree icon.
 */
export function HerdrPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconWorkspaceTreeOutlineRegular size={size} />
}
