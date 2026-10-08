// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { HerdrPanelIcon } from '../src/client/HerdrPanelIcon.tsx'

describe('HerdrPanelIcon', () => {
  it('renders the workspace-tree glyph at the requested edge, reading no application state', () => {
    // The sidebar icon is decorative: every framework standard seat must stay
    // unread, so a throw here fails the test rather than a silent lookup.
    const unread = () => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<HerdrPanelIcon
      size={18}
      active={false}
      usePanelInfo={unread}
      useSessions={unread}
      useSessionStatus={unread}
      useSessionRetainInfo={unread}
      useWorkspaces={unread}
      useResource={unread}
    />)
    const svg = glyph.container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('18')
    expect(svg?.getAttribute('height')).toBe('18')
  })
})
