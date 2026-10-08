// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { HerdrAgentName, HerdrPaneId, HerdrTabId, HerdrWorkspaceId } from '@deepseek-ai/dsh-experimental-herdr'
import type {
  HerdrAgent, HerdrCommandResult, HerdrKey as WireKey, HerdrPane, HerdrReadResult, HerdrTab, HerdrView, HerdrWorkspace,
} from '@deepseek-ai/dsh-experimental-herdr/types'
import { HerdrPanel, type HerdrPanelInjected, type HerdrPanelProps } from '../src/client/HerdrPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { screenBytes } from '../src/client/PaneTerminal.tsx'
import { fit, resetFakeTerminals, terminals, type FakeTerminal } from './fake-xterm.client.ts'

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./fake-xterm.client.ts')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./fake-xterm.client.ts')).FakeFit }))

let observed: (() => void) | undefined
beforeEach(() => {
  resetFakeTerminals()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observed = callback }
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observed = undefined
})

/** The screen of the pane currently shown. */
function shownTerminal(): FakeTerminal {
  const terminal = terminals.at(-1)
  if (terminal === undefined) throw new Error('no terminal was mounted')
  return terminal
}

const workspace: HerdrWorkspace = {
  workspaceId: HerdrWorkspaceId('w1'), label: 'harness', focused: true,
  tabCount: 1, paneCount: 2, agentStatus: 'working',
}
const tab: HerdrTab = {
  tabId: HerdrTabId('w1:t1'), workspaceId: HerdrWorkspaceId('w1'), label: 'main', focused: true,
  paneCount: 2, agentStatus: 'working',
}
const paneOne: HerdrPane = {
  paneId: HerdrPaneId('w1:p1'), workspaceId: HerdrWorkspaceId('w1'), tabId: HerdrTabId('w1:t1'),
  focused: true, agentStatus: 'working', revision: 3, terminalTitle: 'omp-1',
}
const paneTwo: HerdrPane = {
  paneId: HerdrPaneId('w1:p2'), workspaceId: HerdrWorkspaceId('w1'), tabId: HerdrTabId('w1:t1'),
  focused: false, agentStatus: 'blocked', revision: 9, agent: HerdrAgentName('omp'), terminalTitle: 'omp-2',
}
const agent: HerdrAgent = {
  paneId: HerdrPaneId('w1:p2'), workspaceId: HerdrWorkspaceId('w1'), tabId: HerdrTabId('w1:t1'),
  name: HerdrAgentName('dev-b'), agent: 'omp', agentStatus: 'blocked', interactiveReady: true,
  launchPending: false, focused: false,
}
const connected: HerdrView = {
  connection: { status: 'connected', version: '0.8.2', protocol: 20 },
  // Long enough that no refresh tick fires inside a test that is not about it.
  outputRefreshMs: 60_000,
  workspaces: [workspace], tabs: [tab], panes: [paneOne, paneTwo], agents: [agent],
  focusedPaneId: HerdrPaneId('w1:p1'),
}
const readResult: HerdrReadResult = {
  paneId: HerdrPaneId('w1:p1'), text: 'alpha output', cols: 100, revision: 4, truncated: false,
}

/** The panel's injected faces, as the mocks a test asserts on. */
interface BenchFaces {
  readonly hooks: HerdrPanelInjected['hooks']
  readonly read: ReturnType<typeof vi.fn<(paneId: HerdrPaneId) => Promise<HerdrReadResult>>>
  readonly prompt: ReturnType<typeof vi.fn<(paneId: HerdrPaneId, text: string) => Promise<HerdrCommandResult>>>
  readonly sendKeys: ReturnType<typeof vi.fn<(paneId: HerdrPaneId, keys: readonly WireKey[]) => Promise<HerdrCommandResult>>>
  readonly sendText: ReturnType<typeof vi.fn<(paneId: HerdrPaneId, text: string) => Promise<HerdrCommandResult>>>
  readonly focus: ReturnType<typeof vi.fn<(paneId: HerdrPaneId) => Promise<HerdrCommandResult>>>
  readonly restart: ReturnType<typeof vi.fn<() => void>>
}

/**
 * Build the panel's props over one view store.
 * @param initial - first view pushed into the store, or null for a store that
 * has received no frame yet; omission starts connected.
 * @param overrides - command faces to replace.
 * @returns the props, the store, and the mock faces a test asserts on.
 */
function bench(
  initial: HerdrView | null = connected,
  overrides: Partial<BenchFaces> = {},
) {
  const view = createSnapshotStore<HerdrView | undefined>(initial ?? undefined)
  const accept = async (): Promise<HerdrCommandResult> => ({ ok: true })
  const faces: BenchFaces = {
    hooks: { view },
    read: vi.fn(async (paneId: HerdrPaneId) => ({ ...readResult, paneId, text: `output of ${paneId}` })),
    prompt: vi.fn(accept),
    sendKeys: vi.fn(accept),
    sendText: vi.fn(accept),
    focus: vi.fn(accept),
    restart: vi.fn(),
    ...overrides,
  }
  // The panel reads no framework standard seat besides its injected view hook,
  // so every seat the main scope supplies is a throw: a panel that ever reads
  // one fails its own test instead of silently depending on the shell.
  const unread = () => { throw new Error('The Herdr panel must not read a framework standard seat') }
  const props: HerdrPanelProps = {
    useView: bindSnapshotSelector(view),
    usePanelInfo: unread,
    useSessions: unread,
    useSessionStatus: unread,
    useSessionRetainInfo: unread,
    useWorkspaces: unread,
    useResource: unread,
    read: faces.read,
    prompt: faces.prompt,
    sendKeys: faces.sendKeys,
    sendText: faces.sendText,
    focus: faces.focus,
    restart: faces.restart,
    t: makeTranslate(zh, commonZh),
  }
  return { props, view, faces }
}

/** Click one pane row by its accessible selection label. */
function clickPane(paneId: string): void {
  fireEvent.click(screen.getByRole('button', { name: zh.selectPane.replace('{id}', paneId) }))
}

/** Fill the prompt box and press Send. */
function sendPrompt(text: string): void {
  fireEvent.change(screen.getByLabelText(zh.prompt), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: zh.send }))
}

/** The accessible status badge label for one status. */
function badgeLabel(status: string): string {
  return zh.statusLabel.replace('{status}', status)
}

describe('HerdrPanel', () => {
  it('renders the connection line and the workspace tree with status badges', () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    expect(screen.getByText(zh.connected.replace('{version}', '0.8.2').replace('{protocol}', '20'))).toBeTruthy()
    expect(screen.getByText('harness')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getAllByLabelText(badgeLabel(zh.statusWorking))).toHaveLength(1)
    expect(screen.queryByLabelText(badgeLabel(zh.statusBlocked))).toBeNull()
    expect(screen.getByText(zh.focused)).toBeTruthy()
  })

  it('reads and shows the selected pane output, then re-reads on a new selection', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    expect(screen.getByText(zh.selectedPane)).toBeTruthy()
    clickPane('w1:p1')
    await waitFor(() => { expect(screen.getByText('output of w1:p1')).toBeTruthy() })
    expect(b.faces.read).toHaveBeenCalledWith(HerdrPaneId('w1:p1'))
    clickPane('w1:p2')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalledWith(HerdrPaneId('w1:p2')) })
  })

  it('re-reads the selected pane when the pushed revision advances, without any user action', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalledTimes(1) })
    // A pushed frame that advances only w1:p1's revision: the panel re-reads it.
    act(() => {
      b.view.set({ ...connected, panes: [{ ...paneOne, revision: 4 }, paneTwo] })
    })
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalledTimes(2) })
    expect(b.faces.read).toHaveBeenLastCalledWith(HerdrPaneId('w1:p1'))
    // A frame that touches only the other pane leaves the selection alone.
    act(() => {
      b.view.set({ ...connected, panes: [{ ...paneOne, revision: 4 }, { ...paneTwo, revision: 10 }] })
    })
    await Promise.resolve()
    expect(b.faces.read).toHaveBeenCalledTimes(2)
  })

  it('re-reads the pane when the same pane is picked again', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalledTimes(1) })
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalledTimes(2) })
  })

  it('ignores a stale read that lands after the human moved to another pane', async () => {
    const b = bench()
    const slow = Promise.withResolvers<HerdrReadResult>()
    b.faces.read.mockImplementationOnce(async () => await slow.promise)
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    clickPane('w1:p2')
    await waitFor(() => { expect(screen.getByText('output of w1:p2')).toBeTruthy() })
    // The first pane's read settles last; its result must not replace pane 2's.
    act(() => { slow.resolve({ ...readResult, paneId: HerdrPaneId('w1:p1'), text: 'stale' }) })
    await Promise.resolve()
    expect(screen.getByText('output of w1:p2')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('ignores a stale read failure that lands after the human moved to another pane', async () => {
    const b = bench()
    const slow = Promise.withResolvers<HerdrReadResult>()
    b.faces.read.mockImplementationOnce(async () => await slow.promise)
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    clickPane('w1:p2')
    await waitFor(() => { expect(screen.getByText('output of w1:p2')).toBeTruthy() })
    act(() => { slow.reject(new Error('read failed')) })
    // Let the rejected read settle through its handler before asserting.
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(zh.commandFailed.replace('{message}', 'read failed'))).toBeNull()
  })

  it('reports a pane that no longer exists in place of its output', async () => {
    const b = bench(connected, { read: vi.fn(async (): Promise<HerdrReadResult> => ({ notFound: true })) })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p2')
    await waitFor(() => { expect(screen.getByText(zh.outputNotFound)).toBeTruthy() })
  })

  it('reports a truncated pane read', async () => {
    const b = bench(connected, { read: vi.fn(async () => ({ ...readResult, truncated: true })) })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(screen.getByText(zh.outputTruncated)).toBeTruthy() })
  })

  it('prompts the selected pane and clears the draft on success', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p2')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    sendPrompt('ship it')
    await waitFor(() => { expect(b.faces.prompt).toHaveBeenCalledWith(HerdrPaneId('w1:p2'), 'ship it') })
    const draft = screen.getByLabelText(zh.prompt)
    expect(draft instanceof HTMLInputElement && draft.value).toBe('')
  })

  it('reports a rejected command and keeps the draft for a retry', async () => {
    const b = bench(connected, {
      prompt: vi.fn(async () => ({ ok: false, code: 'agent_blocked', message: 'busy' })),
    })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p2')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    sendPrompt('hello')
    await waitFor(() => { expect(screen.getByText(zh.commandRejected.replace('{code}', 'agent_blocked'))).toBeTruthy() })
    const draft = screen.getByLabelText(zh.prompt)
    expect(draft instanceof HTMLInputElement && draft.value).toBe('hello')
  })

  it('addresses every command with the selected pane id', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p2')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalledWith(HerdrPaneId('w1:p2')) })
    sendPrompt('go')
    await waitFor(() => { expect(b.faces.prompt).toHaveBeenCalledWith(HerdrPaneId('w1:p2'), 'go') })
    fireEvent.click(screen.getByRole('button', { name: zh.ctrlC }))
    await waitFor(() => { expect(b.faces.sendKeys).toHaveBeenCalledWith(HerdrPaneId('w1:p2'), ['ctrl+c']) })
    fireEvent.click(screen.getByRole('button', { name: zh.focusPane }))
    await waitFor(() => { expect(b.faces.focus).toHaveBeenCalledWith(HerdrPaneId('w1:p2')) })
  })

  it('withholds the prompt box on a pane with no agent and keeps pane controls available', async () => {
    // w1:p1 hosts no agent: the pane itself can still be focused and keyed.
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalledWith(HerdrPaneId('w1:p1')) })
    expect(screen.getByLabelText(zh.prompt)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh.prompt)).toHaveProperty('placeholder', zh.noAgent)
    expect(screen.getByRole('button', { name: zh.send })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh.esc })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: zh.focusPane })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: zh.focusPane }))
    await waitFor(() => { expect(b.faces.focus).toHaveBeenCalledWith(HerdrPaneId('w1:p1')) })
  })

  it('offers the prompt box on a pane that hosts an agent', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p2')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    expect(screen.getByLabelText(zh.prompt)).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(zh.prompt)).toHaveProperty('placeholder', zh.promptPlaceholder)
  })

  it('shows no agent status badge for a pane with no agent, and one for a hosted agent', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    // Only the workspace badge exists before any pane is selected.
    expect(screen.getAllByLabelText(badgeLabel(zh.statusWorking))).toHaveLength(1)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    // The agent-less pane row carries no status dot at all; the agent's pane does.
    const row = (paneId: string) => screen.getByRole('button', { name: zh.selectPane.replace('{id}', paneId) })
    expect(row('w1:p1').querySelector('[data-state]')).toBeNull()
    expect(row('w1:p2').querySelector('[data-state]')).not.toBeNull()
    expect(screen.queryByLabelText(badgeLabel(zh.statusUnknown))).toBeNull()
    // Selecting the agent's pane shows that agent's own status.
    clickPane('w1:p2')
    await waitFor(() => { expect(screen.getByLabelText(badgeLabel(zh.statusBlocked))).toBeTruthy() })
  })

  it('re-reads the pane after a key so its reaction is shown', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    const before = b.faces.read.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: zh.esc }))
    await waitFor(() => { expect(b.faces.sendKeys).toHaveBeenCalledWith(HerdrPaneId('w1:p1'), ['esc']) })
    await waitFor(() => { expect(b.faces.read.mock.calls.length).toBe(before + 1) })
  })

  it('reports a thrown command as a failure line', async () => {
    const b = bench(connected, { focus: vi.fn(async () => { throw new Error('socket gone') }) })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    fireEvent.click(screen.getByRole('button', { name: zh.focusPane }))
    await waitFor(() => { expect(screen.getByText(zh.commandFailed.replace('{message}', 'socket gone'))).toBeTruthy() })
  })

  it('focuses the selected pane through the injected action', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    fireEvent.click(screen.getByRole('button', { name: zh.focusPane }))
    await waitFor(() => { expect(b.faces.focus).toHaveBeenCalledWith(HerdrPaneId('w1:p1')) })
  })

  it('sends each offered key to the selected pane, in the offered order', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    const keys: readonly { readonly label: string; readonly wire: WireKey }[] = [
      { label: zh.esc, wire: 'esc' },
      { label: zh.ctrlC, wire: 'ctrl+c' },
      { label: zh.enter, wire: 'enter' },
      { label: zh.up, wire: 'up' },
      { label: zh.down, wire: 'down' },
      { label: zh.yes, wire: 'y' },
      { label: zh.no, wire: 'n' },
    ]
    for (const { label, wire } of keys) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      await waitFor(() => { expect(b.faces.sendKeys).toHaveBeenCalledWith(HerdrPaneId('w1:p1'), [wire]) })
    }
    expect(b.faces.sendKeys.mock.calls.map(call => call[1])).toEqual(keys.map(({ wire }) => [wire]))
  })

  it('renders the unavailable state with its reason and retries on demand', () => {
    const b = bench({
      connection: { status: 'unavailable', reason: 'ENOENT' },
      outputRefreshMs: 60_000,
      workspaces: [], tabs: [], panes: [], agents: [],
    })
    render(<HerdrPanel {...b.props} />)
    expect(screen.getAllByText(zh.unavailable).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(zh.unavailableReason.replace('{reason}', 'ENOENT'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(b.faces.restart).toHaveBeenCalled()
  })

  it('renders the incompatible state with both protocol numbers and a retry that reopens the watch', () => {
    const b = bench({
      connection: { status: 'incompatible', expected: 20, actual: 19 },
      outputRefreshMs: 60_000,
      workspaces: [], tabs: [], panes: [], agents: [],
    })
    render(<HerdrPanel {...b.props} />)
    expect(screen.getAllByText(zh.incompatible).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(zh.incompatibleHint.replace('{expected}', '20').replace('{actual}', '19'))).toBeTruthy()
    // A newer Herdr server is only discovered by probing again, so the state
    // that needs a fresh watch offers the same control as the unreachable one.
    expect(screen.queryByText(zh.unavailableReason.replace('{reason}', 'x'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(b.faces.restart).toHaveBeenCalledTimes(1)
  })

  it('shows the reading state before the first frame and the empty state for a connected empty server', () => {
    const b = bench(null)
    render(<HerdrPanel {...b.props} />)
    expect(screen.getByText(zh.reading)).toBeTruthy()
    act(() => {
      b.view.set({ connection: { status: 'connected', version: '0.8.2', protocol: 20 }, outputRefreshMs: 60_000, workspaces: [], tabs: [], panes: [], agents: [] })
    })
    expect(screen.getByText(zh.empty)).toBeTruthy()
  })

  it('shows the empty tabs state, the detected agent kind, and the no-agent placeholder', () => {
    const b = bench({ ...connected, tabs: [], panes: [], agents: [] })
    const first = render(<HerdrPanel {...b.props} />)
    expect(screen.getByText(zh.emptyTabs)).toBeTruthy()
    first.unmount()
    // A pane Herdr hosts an agent in but never named renders the detected kind.
    const kind = bench({ ...connected, panes: [paneTwo], agents: [] })
    const second = render(<HerdrPanel {...kind.props} />)
    expect(screen.getByText('omp')).toBeTruthy()
    second.unmount()
    // A pane with no agent at all renders the placeholder.
    const bare = bench({ ...connected, panes: [paneOne, paneTwo], agents: [] })
    render(<HerdrPanel {...bare.props} />)
    expect(screen.getByText(zh.noAgent)).toBeTruthy()
  })

  it('shows the empty pane list state inside a tab that holds none', () => {
    const b = bench({ ...connected, tabs: [{ ...tab, paneCount: 0 }], panes: [], agents: [] })
    render(<HerdrPanel {...b.props} />)
    expect(screen.getByText(zh.emptyPanes)).toBeTruthy()
  })

  it('renders an unknown agent status neutrally and an empty pane read as an empty screen', async () => {
    const b = bench(
      {
        ...connected,
        workspaces: [{ ...workspace, agentStatus: 'unknown' }],
        tabs: [{ ...tab, agentStatus: 'unknown' }],
        panes: [{ ...paneOne, agentStatus: 'unknown' }],
        agents: [],
      },
      { read: vi.fn(async () => ({ ...readResult, text: '' })) },
    )
    render(<HerdrPanel {...b.props} />)
    expect(screen.getByLabelText(badgeLabel(zh.statusUnknown))).toBeTruthy()
    clickPane('w1:p1')
    await waitFor(() => { expect(shownTerminal().writes).toEqual(['']) })
  })

  it('maps the remaining wire statuses to their own badge copy', () => {
    const busy = bench({ ...connected, workspaces: [{ ...workspace, agentStatus: 'idle' }] })
    const first = render(<HerdrPanel {...busy.props} />)
    expect(screen.getByLabelText(badgeLabel(zh.statusIdle))).toBeTruthy()
    first.unmount()
    const finished = bench({ ...connected, workspaces: [{ ...workspace, agentStatus: 'done' }] })
    render(<HerdrPanel {...finished.props} />)
    expect(screen.getByLabelText(badgeLabel(zh.statusDone))).toBeTruthy()
  })

  it('reports a read failure on the error line, in either thrown form', async () => {
    const b = bench(connected, { read: vi.fn(async () => { throw new Error('read failed') }) })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(screen.getByText(zh.commandFailed.replace('{message}', 'read failed'))).toBeTruthy() })
    cleanup()
    const plain = bench(connected, { read: vi.fn(async () => { throw 'plain failure' }) })
    render(<HerdrPanel {...plain.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(screen.getByText(zh.commandFailed.replace('{message}', 'plain failure'))).toBeTruthy() })
  })

  it('labels a pane without a terminal title by its id and hides the controls until one is selected', () => {
    const { terminalTitle: _omitted, ...untitled } = paneOne
    const b = bench({ ...connected, panes: [untitled] })
    render(<HerdrPanel {...b.props} />)
    expect(screen.getByText(zh.paneLabel.replace('{id}', 'w1:p1'))).toBeTruthy()
    // Nothing is selected yet, so no control can act on a pane.
    expect(screen.getByText(zh.selectedPane)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.focusPane })).toBeNull()
    expect(screen.queryByRole('button', { name: zh.send })).toBeNull()
    expect(screen.queryByRole('button', { name: zh.esc })).toBeNull()
  })

  it('keeps Send disabled while the draft is blank', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read).toHaveBeenCalled() })
    fireEvent.change(screen.getByLabelText(zh.prompt), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: zh.send })).toHaveProperty('disabled', true)
  })

  it('re-reads the shown pane at the Host interval although its revision never moves', async () => {
    const b = bench({ ...connected, outputRefreshMs: 20 })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(b.faces.read.mock.calls.length).toBeGreaterThanOrEqual(3) })
    expect(new Set(b.faces.read.mock.calls.map(([paneId]) => paneId))).toEqual(new Set([HerdrPaneId('w1:p1')]))
  })

  it('skips a refresh tick while a read is still in flight', async () => {
    let release: (value: HerdrReadResult) => void = () => {}
    const read = vi.fn(async (paneId: HerdrPaneId) => {
      if (read.mock.calls.length === 1) return { ...readResult, paneId }
      return new Promise<HerdrReadResult>((resolve) => { release = resolve })
    })
    const b = bench({ ...connected, outputRefreshMs: 15 }, { read })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { release({ ...readResult, text: 'late' }) })
    await waitFor(() => { expect(read.mock.calls.length).toBeGreaterThan(2) })
  })

  it('sends the prompt when Enter submits the box', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p2')
    const box = screen.getByLabelText(zh.prompt)
    fireEvent.change(box, { target: { value: 'go on' } })
    const form = box.closest('form')
    expect(form).not.toBeNull()
    if (form !== null) fireEvent.submit(form)
    await waitFor(() => { expect(b.faces.prompt).toHaveBeenCalledWith(HerdrPaneId('w1:p2'), 'go on') })
  })

  it('ignores Enter on an empty draft or an agent-less pane', () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p2')
    const form = screen.getByLabelText(zh.prompt).closest('form')
    if (form !== null) fireEvent.submit(form)
    clickPane('w1:p1')
    fireEvent.change(screen.getByLabelText(zh.prompt), { target: { value: 'ignored' } })
    const shellForm = screen.getByLabelText(zh.prompt).closest('form')
    if (shellForm !== null) fireEvent.submit(shellForm)
    expect(b.faces.prompt).not.toHaveBeenCalled()
  })

  it('renders the read in a screen at the pane width and fits only the height', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await screen.findByText('output of w1:p1')
    const terminal = shownTerminal()
    expect(terminal.cols).toBe(100)
    expect(terminal.rows).toBe(30)
    expect(terminal.textarea?.getAttribute('aria-label')).toBe(zh.terminal.replace('{id}', 'w1:p1'))
    fit.rows = 12
    observed?.()
    expect(terminal.rows).toBe(12)
    expect(terminal.cols).toBe(100)
    fit.rows = undefined
    observed?.()
    expect(terminal.rows).toBe(12)
  })

  it('follows a pane width change without remounting the screen', async () => {
    let cols = 100
    const b = bench(connected, { read: vi.fn(async (paneId: HerdrPaneId) => ({ ...readResult, paneId, cols, text: `cols ${String(cols)}` })) })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await screen.findByText('cols 100')
    cols = 80
    act(() => { b.view.set({ ...connected, panes: [{ ...paneOne, revision: 4 }, paneTwo] }) })
    await screen.findByText('cols 80')
    expect(terminals).toHaveLength(1)
    expect(shownTerminal().cols).toBe(80)
  })

  it('replaces the screen on each read but holds it while the human scrolls history', async () => {
    let text = 'first'
    const b = bench(connected, { read: vi.fn(async (paneId: HerdrPaneId) => ({ ...readResult, paneId, text })) })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await screen.findByText('first')
    const terminal = shownTerminal()
    text = 'second'
    act(() => { b.view.set({ ...connected, panes: [{ ...paneOne, revision: 4 }, paneTwo] }) })
    await screen.findByText('second')
    terminal.buffer.active.baseY = 50
    terminal.buffer.active.viewportY = 10
    const resets = terminal.resets
    text = 'third'
    act(() => { b.view.set({ ...connected, panes: [{ ...paneOne, revision: 5 }, paneTwo] }) })
    await waitFor(() => { expect(b.faces.read.mock.calls.length).toBeGreaterThanOrEqual(3) })
    expect(terminal.resets).toBe(resets)
    expect(screen.getByText('second')).toBeTruthy()
  })

  it('types screen input into the selected pane in order, batching keys sent meanwhile', async () => {
    let release: (value: HerdrCommandResult) => void = () => {}
    const sendText = vi.fn(async (_paneId: HerdrPaneId, _text: string): Promise<HerdrCommandResult> => {
      if (sendText.mock.calls.length > 1) return { ok: true }
      return new Promise<HerdrCommandResult>((resolve) => { release = resolve })
    })
    const b = bench(connected, { sendText })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await screen.findByText('output of w1:p1')
    const reads = b.faces.read.mock.calls.length
    act(() => { shownTerminal().type('l') })
    act(() => { shownTerminal().type('s') })
    act(() => { shownTerminal().type('\r') })
    expect(sendText).toHaveBeenCalledTimes(1)
    await act(async () => { release({ ok: true }) })
    await waitFor(() => { expect(sendText).toHaveBeenCalledTimes(2) })
    expect(sendText.mock.calls.map(([, text]) => text)).toEqual(['l', 's\r'])
    expect(sendText.mock.calls.every(([paneId]) => paneId === HerdrPaneId('w1:p1'))).toBe(true)
    await waitFor(() => { expect(b.faces.read.mock.calls.length).toBeGreaterThan(reads) })
  })

  it('reports refused and thrown screen input beside the controls', async () => {
    const sendText = vi.fn(async (): Promise<HerdrCommandResult> => ({ ok: false, code: 'input_too_large', message: 'big' }))
    const b = bench(connected, { sendText })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await screen.findByText('output of w1:p1')
    act(() => { shownTerminal().type('x') })
    await screen.findByText(zh.commandRejected.replace('{code}', 'input_too_large'))
    sendText.mockImplementationOnce(async () => { throw new Error('socket gone') })
    act(() => { shownTerminal().type('y') })
    await screen.findByText(zh.commandFailed.replace('{message}', 'socket gone'))
  })

  it('remounts the screen for another pane and drops input typed for the previous one', async () => {
    const b = bench()
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await screen.findByText('output of w1:p1')
    const first = shownTerminal()
    clickPane('w1:p2')
    await screen.findByText('output of w1:p2')
    expect(first.disposed).toBe(true)
    expect(terminals).toHaveLength(2)
  })

  it('queues a re-read of the pane being read and runs it once that read settles', async () => {
    let release: (value: HerdrReadResult) => void = () => {}
    const read = vi.fn(async (paneId: HerdrPaneId): Promise<HerdrReadResult> => {
      if (read.mock.calls.length !== 2) return { ...readResult, paneId, text: `read ${String(read.mock.calls.length)}` }
      return new Promise<HerdrReadResult>((resolve) => { release = resolve })
    })
    const b = bench(connected, { read })
    render(<HerdrPanel {...b.props} />)
    clickPane('w1:p1')
    await screen.findByText('read 1')
    act(() => { b.view.set({ ...connected, panes: [{ ...paneOne, revision: 4 }, paneTwo] }) })
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
    act(() => { shownTerminal().type('x') })
    await waitFor(() => { expect(b.faces.sendText).toHaveBeenCalled() })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { release({ ...readResult, text: 'read 2' }) })
    await screen.findByText('read 3')
  })

  it('normalizes rows to CRLF and drops trailing blank rows so the cursor ends on the last row', () => {
    expect(screenBytes('a\nb\r\n\u001b[0m\n  \n')).toBe('a\r\nb')
    expect(screenBytes('prompt $ ')).toBe('prompt $ ')
  })
})
