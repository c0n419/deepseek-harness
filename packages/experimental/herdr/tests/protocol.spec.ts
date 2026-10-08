/** Wire codec: framing, snake→camel mapping, event payloads, and error classification. */

import { describe, expect, it } from 'vitest'
import {
  HerdrProtocolError, connectionOf, invalidKey, parseEvent, parseFrame, parseLayoutCols, parsePong, parseRead,
  parseSnapshot, viewSubscriptions,
} from '../src/protocol.ts'
import { HerdrPaneId } from '../src/brand.ts'
import { asError } from '../src/protocol.ts'

describe('asError', () => {
  it('returns a thrown Error unchanged and wraps a thrown non-Error', () => {
    const original = new Error('boom')
    expect(asError(original)).toBe(original)
    expect(asError('boom')).toBeInstanceOf(Error)
    expect(asError('boom').message).toBe('boom')
  })
})

describe('parseFrame', () => {
  it('reads a result envelope and an error envelope, correlating nothing to the echoed id', () => {
    expect(parseFrame('{"id":"a","result":{"type":"pong"}}')).toEqual({ result: { type: 'pong' } })
    expect(parseFrame('{"id":"","error":{"code":"invalid_request","message":"bad"}}'))
      .toEqual({ error: { code: 'invalid_request', message: 'bad' } })
  })

  it('rejects a frame that is neither result nor error', () => {
    expect(() => parseFrame('{"id":"a"}')).toThrow(HerdrProtocolError)
    expect(() => parseFrame('[]')).toThrow('not a JSON object')
    expect(() => parseFrame('{"id":"a","error":{}}')).toThrow('error.code is not a string')
  })
})

describe('pong and compatibility', () => {
  it('reports connected for the expected protocol and incompatible otherwise', () => {
    const pong = { type: 'pong', version: '0.8.2', protocol: 20 }
    expect(connectionOf(20, pong)).toEqual({ status: 'connected', version: '0.8.2', protocol: 20 })
    expect(connectionOf(21, pong)).toEqual({ status: 'incompatible', expected: 21, actual: 20 })
    expect(parsePong(pong)).toEqual({ version: '0.8.2', protocol: 20 })
  })

  it('rejects a payload that is not a pong and a non-numeric protocol', () => {
    expect(() => parsePong({ type: 'ok' })).toThrow('expected pong, received ok')
    expect(() => parsePong({ type: 'pong', version: '1', protocol: '20' })).toThrow('pong.protocol is not a finite number')
  })
})

describe('snapshot decoding', () => {
  it('brands every handle and maps the server spelling onto the seam vocabulary', () => {
    const parsed = parseSnapshot({ type: 'session_snapshot', snapshot: {
      focused_pane_id: 'w1:p2',
      workspaces: [{ workspace_id: 'w1', label: 'repo', focused: true, tab_count: 1, pane_count: 2, agent_status: 'working' }],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', focused: true, pane_count: 2, agent_status: 'working' }],
      panes: [{ pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, agent_status: 'idle', revision: 3,
        agent: 'omp', foreground_cwd: '/repo', terminal_title: 'π repo' }],
      agents: [{ pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', name: 'dev-a', agent: 'omp',
        agent_status: 'blocked', interactive_ready: true, launch_pending: false, focused: false }],
    } })
    expect(parsed.focusedPaneId).toBe('w1:p2')
    expect(parsed.workspaces[0]).toEqual({ workspaceId: 'w1', label: 'repo', focused: true, tabCount: 1, paneCount: 2, agentStatus: 'working' })
    expect(parsed.panes[0]).toEqual({ paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t1', focused: true,
      agentStatus: 'idle', revision: 3, agent: 'omp', foregroundCwd: '/repo', terminalTitle: 'π repo' })
    expect(parsed.agents[0]).toEqual({ paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t1', name: 'dev-a', agent: 'omp',
      agentStatus: 'blocked', interactiveReady: true, launchPending: false, focused: false })
  })

  it('omits absent optional fields and normalizes an unrecognized agent state', () => {
    const parsed = parseSnapshot({ type: 'session_snapshot', snapshot: { workspaces: [], tabs: [],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: false, agent_status: 'something-new', revision: 0 }],
      agents: [] } })
    expect(parsed.focusedPaneId).toBeUndefined()
    expect(parsed.panes[0]?.agentStatus).toBe('unknown')
    expect('agent' in (parsed.panes[0] ?? {})).toBe(false)
  })

  it('keeps an unnamed agent without a name field and one naming its kind', () => {
    const parsed = parseSnapshot({ type: 'session_snapshot', snapshot: { workspaces: [], tabs: [], panes: [],
      agents: [
        { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'omp', agent_status: 'idle',
          interactive_ready: false, launch_pending: true, focused: false },
        { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', name: 'dev-a', agent_status: 'working',
          interactive_ready: true, launch_pending: false, focused: true },
      ] } })
    expect(parsed.agents[0]).not.toHaveProperty('name')
    expect(parsed.agents[0]?.agent).toBe('omp')
    expect(parsed.agents[0]?.interactiveReady).toBe(false)
    expect(parsed.agents[0]?.launchPending).toBe(true)
    expect(parsed.agents[1]?.name).toBe('dev-a')
    expect(parsed.agents[1]).not.toHaveProperty('agent')
  })

  it('keeps the agent name of a pane that has one and rejects a malformed boolean', () => {
    const parsed = parseSnapshot({ type: 'session_snapshot', snapshot: { workspaces: [], tabs: [],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: false, agent_status: 'idle', revision: 1, agent: 'omp' }],
      agents: [] } })
    expect(parsed.panes[0]?.agent).toBe('omp')
    expect(() => parseSnapshot({ type: 'session_snapshot', snapshot: { workspaces: [], tabs: [],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: 'yes', agent_status: 'idle', revision: 1 }],
      agents: [] } })).toThrow('pane.focused is not a boolean')
  })

  it('rejects a payload of the wrong type or with a malformed list', () => {
    expect(() => parseSnapshot({ type: 'ok' })).toThrow('expected session_snapshot, received ok')
    expect(() => parseSnapshot({ type: 'session_snapshot', snapshot: { workspaces: {}, tabs: [], panes: [], agents: [] } }))
      .toThrow('snapshot.workspaces is not an array')
  })
})

describe('read decoding', () => {
  it('reads text with its revision', () => {
    const paneId = HerdrPaneId('w1:p1')
    expect(parseRead(paneId, { type: 'pane_read', read: { text: 'hello', revision: 4, truncated: true } }, 80))
      .toEqual({ paneId, text: 'hello', cols: 80, revision: 4, truncated: true })
  })

  it('rejects a payload that is not a pane read', () => {
    expect(() => parseRead(HerdrPaneId('w1:p1'), { type: 'ok' }, 80)).toThrow('expected pane_read, received ok')
  })

  it('finds a pane width in a layout and reports a pane the layout no longer holds', () => {
    const layout = { type: 'pane_layout', layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 97 } }] } }
    expect(parseLayoutCols(HerdrPaneId('w1:p1'), layout)).toBe(97)
    expect(parseLayoutCols(HerdrPaneId('w1:p2'), layout)).toBeUndefined()
    expect(() => parseLayoutCols(HerdrPaneId('w1:p1'), { type: 'ok' })).toThrow('expected pane_layout, received ok')
  })
})

describe('event decoding', () => {
  it('decodes a pane_updated payload and passes every other event through by name', () => {
    expect(parseEvent('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"working","revision":9}}}'))
      .toEqual({ event: 'pane_updated', pane: { paneId: 'w1:p1', workspaceId: 'w1', tabId: 'w1:t1', focused: false, agentStatus: 'working', revision: 9 } })
    expect(parseEvent('{"event":"layout.updated","data":{"type":"layout_updated"}}')).toEqual({ event: 'layout.updated' })
  })

  it('rejects a malformed event frame', () => {
    expect(() => parseEvent('{"data":{}}')).toThrow('event.event is not a string')
  })
})

describe('subscription composition', () => {
  it('subscribes global topology globally and the per-pane state event per pane', () => {
    const subscriptions = viewSubscriptions([HerdrPaneId('w1:p1'), HerdrPaneId('w1:p2')])
    expect(subscriptions).toContainEqual({ type: 'pane.updated' })
    expect(subscriptions.filter(s => s.pane_id !== undefined))
      .toEqual([{ type: 'pane.agent_status_changed', pane_id: 'w1:p1' }, { type: 'pane.agent_status_changed', pane_id: 'w1:p2' }])
  })
})

describe('key allowlist', () => {
  it('admits the surface keys and reports the first rejected one', () => {
    expect(invalidKey(['esc', 'ctrl+c', 'enter', 'up', 'down', 'y', 'n'])).toBeUndefined()
    expect(invalidKey(['y', 'ctrl+shift+delete'])).toBe('ctrl+shift+delete')
  })
})
