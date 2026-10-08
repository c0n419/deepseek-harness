/**
 * Wire codec for the Herdr socket API: it validates every frame the server
 * sends, maps the server's snake_case spelling onto the seam vocabulary, and
 * classifies a refused request. Nothing outside this module knows the wire
 * spelling.
 *
 * Protocol facts this encodes (verified against herdr 0.8.2, protocol 20):
 * - one JSON object per `\n`-terminated line, in both directions;
 * - a reply is `{id, result}` or `{id, error}`; `result.type` discriminates;
 * - a validation failure answers with an empty `id`, so a reply is correlated
 *   to the single in-flight request, never to the echoed id.
 * @module @deepseek-ai/dsh-experimental-herdr/protocol
 */

import {
  HerdrAgentName, HerdrPaneId, HerdrTabId, HerdrWorkspaceId,
} from './brand.ts'
import { HERDR_KEYS } from './types.ts'
import type { HerdrAgentStatus as AgentStatus } from './types.ts'
import type {
  HerdrAgent, HerdrConnection, HerdrPane, HerdrRead, HerdrTab, HerdrWorkspace,
} from './types.ts'

/** A frame the server could not be parsed as either a result or an error. */
export class HerdrProtocolError extends Error {
  /**
   * @param message - what was unparseable, with the offending text.
   */
  constructor(message: string) {
    super(message)
    this.name = 'HerdrProtocolError'
  }
}

/** A frame line the server rejected before it could name a method. */
export interface ParsedFrame {
  /** Server result payload, when the frame carried one. */
  result?: unknown
  /** Server error payload, when the frame carried one. */
  error?: { code: string; message: string }
}

/**
 * Narrow a thrown value to an Error, so a failure path never has to branch on
 * `instanceof Error` at each catch site.
 * @param error - caught value.
 * @returns the same Error, or one wrapping the thrown value's string form.
 */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HerdrProtocolError(`herdr: ${what} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Parse one frame line. A malformed line is a protocol failure, not a
 * `SyntaxError` a caller has to know about.
 * @param line - one complete, newline-free frame.
 * @param what - label for the failure message.
 * @returns the parsed value.
 * @throws HerdrProtocolError when the line is not valid JSON.
 */
function parseJson(line: string, what: string): unknown {
  try {
    return JSON.parse(line)
  } catch (error: unknown) {
    throw new HerdrProtocolError(`herdr: ${what} is not valid JSON: ${asError(error).message}`)
  }
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new HerdrProtocolError(`herdr: ${what} is not a string`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HerdrProtocolError(`herdr: ${what} is not a finite number`)
  }
  return value
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new HerdrProtocolError(`herdr: ${what} is not a boolean`)
  return value
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new HerdrProtocolError(`herdr: ${what} is not an array`)
  return value
}

/**
 * Parse one reply line.
 * @param line - one complete, newline-free frame.
 * @returns the result payload, or the error payload when the server refused.
 * @throws HerdrProtocolError when the line is not a well-formed reply.
 */
export function parseFrame(line: string): ParsedFrame {
  const envelope = asRecord(parseJson(line, 'frame'), 'frame')
  const error = envelope.error
  if (error !== undefined) {
    const body = asRecord(error, 'error')
    return { error: { code: asString(body.code, 'error.code'), message: asString(body.message, 'error.message') } }
  }
  if (!('result' in envelope)) throw new HerdrProtocolError('herdr: frame carries neither result nor error')
  return { result: envelope.result }
}

const AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown']

/** Normalize the server's agent state; an unrecognized state is `unknown`. */
function agentStatus(value: unknown): AgentStatus {
  return AGENT_STATUSES.find(status => status === value) ?? 'unknown'
}

/**
 * Read the `ping` result, which carries the server's identity.
 * @param result - parsed `ping` result payload.
 * @returns the server version, protocol number, and capabilities.
 * @throws HerdrProtocolError when the payload is not a `pong`.
 */
export function parsePong(result: unknown): { version: string; protocol: number } {
  const body = asRecord(result, 'ping result')
  if (body.type !== 'pong') throw new HerdrProtocolError(`herdr: expected pong, received ${String(body.type)}`)
  return { version: asString(body.version, 'pong.version'), protocol: asNumber(body.protocol, 'pong.protocol') }
}

/**
 * Read the reachability fields a `pong` carries into a seam connection state.
 * @param expected - protocol number this build speaks.
 * @param result - parsed `ping` result payload.
 * @returns `connected` or `incompatible`; a mismatch never silently proceeds.
 * @throws HerdrProtocolError when the payload is not a `pong`.
 */
export function connectionOf(expected: number, result: unknown): HerdrConnection {
  const { version, protocol } = parsePong(result)
  return protocol === expected
    ? { status: 'connected', version, protocol }
    : { status: 'incompatible', expected, actual: protocol }
}

function workspaceOf(value: unknown): HerdrWorkspace {
  const raw = asRecord(value, 'workspace')
  return {
    workspaceId: HerdrWorkspaceId(asString(raw.workspace_id, 'workspace.workspace_id')),
    label: asString(raw.label, 'workspace.label'),
    focused: asBoolean(raw.focused, 'workspace.focused'),
    tabCount: asNumber(raw.tab_count, 'workspace.tab_count'),
    paneCount: asNumber(raw.pane_count, 'workspace.pane_count'),
    agentStatus: agentStatus(raw.agent_status),
  }
}

function tabOf(value: unknown): HerdrTab {
  const raw = asRecord(value, 'tab')
  return {
    tabId: HerdrTabId(asString(raw.tab_id, 'tab.tab_id')),
    workspaceId: HerdrWorkspaceId(asString(raw.workspace_id, 'tab.workspace_id')),
    label: asString(raw.label, 'tab.label'),
    focused: asBoolean(raw.focused, 'tab.focused'),
    paneCount: asNumber(raw.pane_count, 'tab.pane_count'),
    agentStatus: agentStatus(raw.agent_status),
  }
}

function paneOf(value: unknown): HerdrPane {
  const raw = asRecord(value, 'pane')
  const agent = optionalString(raw.agent)
  const foregroundCwd = optionalString(raw.foreground_cwd)
  const terminalTitle = optionalString(raw.terminal_title)
  return {
    paneId: HerdrPaneId(asString(raw.pane_id, 'pane.pane_id')),
    workspaceId: HerdrWorkspaceId(asString(raw.workspace_id, 'pane.workspace_id')),
    tabId: HerdrTabId(asString(raw.tab_id, 'pane.tab_id')),
    focused: asBoolean(raw.focused, 'pane.focused'),
    agentStatus: agentStatus(raw.agent_status),
    revision: asNumber(raw.revision, 'pane.revision'),
    ...agent === undefined ? {} : { agent: HerdrAgentName(agent) },
    ...foregroundCwd === undefined ? {} : { foregroundCwd },
    ...terminalTitle === undefined ? {} : { terminalTitle },
  }
}

function agentOf(value: unknown): HerdrAgent {
  const raw = asRecord(value, 'agent')
  const name = optionalString(raw.name)
  const kind = optionalString(raw.agent)
  return {
    paneId: HerdrPaneId(asString(raw.pane_id, 'agent.pane_id')),
    workspaceId: HerdrWorkspaceId(asString(raw.workspace_id, 'agent.workspace_id')),
    tabId: HerdrTabId(asString(raw.tab_id, 'agent.tab_id')),
    ...name === undefined ? {} : { name: HerdrAgentName(name) },
    ...kind === undefined ? {} : { agent: kind },
    agentStatus: agentStatus(raw.agent_status),
    interactiveReady: raw.interactive_ready === true,
    launchPending: raw.launch_pending === true,
    focused: asBoolean(raw.focused, 'agent.focused'),
  }
}

/** Every list the view assembles, decoded from their respective results. */
export interface ParsedView {
  /** Workspaces of the server's session. */
  workspaces: HerdrWorkspace[]
  /** Tabs of those workspaces. */
  tabs: HerdrTab[]
  /** Panes of those tabs. */
  panes: HerdrPane[]
  /** Panes hosting agents. */
  agents: HerdrAgent[]
  /** Server-focused pane, when named. */
  focusedPaneId?: HerdrPaneId
}

/**
 * Decode a `session.snapshot` result into the view's lists.
 * @param result - parsed `session.snapshot` result payload.
 * @returns every list the view carries, with handles branded.
 * @throws HerdrProtocolError when the payload is not a session snapshot.
 */
export function parseSnapshot(result: unknown): ParsedView {
  const body = asRecord(result, 'snapshot result')
  if (body.type !== 'session_snapshot') {
    throw new HerdrProtocolError(`herdr: expected session_snapshot, received ${String(body.type)}`)
  }
  const snapshot = asRecord(body.snapshot, 'snapshot')
  const focused = optionalString(snapshot.focused_pane_id)
  return {
    workspaces: asArray(snapshot.workspaces, 'snapshot.workspaces').map(workspaceOf),
    tabs: asArray(snapshot.tabs, 'snapshot.tabs').map(tabOf),
    panes: asArray(snapshot.panes, 'snapshot.panes').map(paneOf),
    agents: asArray(snapshot.agents, 'snapshot.agents').map(agentOf),
    ...focused === undefined ? {} : { focusedPaneId: HerdrPaneId(focused) },
  }
}

/**
 * Decode a `pane.read` result.
 * @param paneId - the pane that was read, echoed into the result.
 * @param result - parsed `pane.read` result payload.
 * @param cols - the pane's terminal columns, from its layout rectangle.
 * @returns the pane's text with its revision.
 * @throws HerdrProtocolError when the payload is not a pane read.
 */
export function parseRead(paneId: HerdrPaneId, result: unknown, cols: number): HerdrRead {
  const body = asRecord(result, 'read result')
  if (body.type !== 'pane_read') throw new HerdrProtocolError(`herdr: expected pane_read, received ${String(body.type)}`)
  const read = asRecord(body.read, 'read')
  return {
    paneId,
    text: asString(read.text, 'read.text'),
    cols,
    revision: asNumber(read.revision, 'read.revision'),
    truncated: asBoolean(read.truncated, 'read.truncated'),
  }
}

/**
 * Find one pane's terminal width in a `pane.layout` result.
 * @param paneId - the pane whose rectangle is wanted.
 * @param result - parsed `pane.layout` result payload.
 * @returns the pane's columns, or undefined when the layout no longer holds the pane.
 * @throws HerdrProtocolError when the payload is not a pane layout.
 */
export function parseLayoutCols(paneId: HerdrPaneId, result: unknown): number | undefined {
  const body = asRecord(result, 'layout result')
  if (body.type !== 'pane_layout') throw new HerdrProtocolError(`herdr: expected pane_layout, received ${String(body.type)}`)
  const layout = asRecord(body.layout, 'layout')
  for (const entry of asArray(layout.panes, 'layout.panes')) {
    const pane = asRecord(entry, 'layout pane')
    if (pane.pane_id === paneId) return asNumber(asRecord(pane.rect, 'layout pane rect').width, 'layout pane rect.width')
  }
  return undefined
}

/**
 * Decode a pushed subscription envelope.
 * @param line - one complete, newline-free frame from a subscription connection.
 * @returns the event name and its parsed payload.
 * @throws HerdrProtocolError when the frame is not a subscription event.
 */
export function parseEvent(line: string): { event: string; pane?: HerdrPane } {
  const envelope = asRecord(parseJson(line, 'event frame'), 'event frame')
  const event = asString(envelope.event, 'event.event')
  if (event !== 'pane_updated') return { event }
  const data = asRecord(envelope.data, 'event.data')
  return { event, pane: paneOf(data.pane) }
}

/**
 * Build the subscription list the view is maintained from.
 *
 * Topology events are global; only the per-pane agent-state event takes a
 * `pane_id`, and it is required there — the server rejects that subscription
 * without one. A pane's *output* is not pushed at all: only `pane.updated`
 * (which carries the pane's revision, not its text) is, so text stays a lazy
 * `pane.read` at the selection the watcher actually needs.
 *
 * @param paneIds - panes whose agent-state transitions the watcher needs.
 * @returns the `events.subscribe` subscriptions, in request order.
 */
export function viewSubscriptions(paneIds: readonly HerdrPaneId[]): Record<string, unknown>[] {
  return [
    { type: 'workspace.created' },
    { type: 'workspace.updated' },
    { type: 'workspace.closed' },
    { type: 'workspace.focused' },
    { type: 'tab.created' },
    { type: 'tab.closed' },
    { type: 'tab.focused' },
    { type: 'pane.created' },
    { type: 'pane.closed' },
    { type: 'pane.updated' },
    { type: 'pane.focused' },
    { type: 'pane.moved' },
    { type: 'pane.exited' },
    ...paneIds.map(pane_id => ({ type: 'pane.agent_status_changed', pane_id })),
  ]
}

/**
 * The first key a {@link HERDR_KEYS} member does not cover, checked before any
 * byte reaches the pane. The allowlist has one definition — the exported
 * constant — so this check cannot drift from the {@link HerdrKey} union.
 *
 * The parameter is the unchecked wire value, not the union: the whole point of
 * this check is to reject a key the type system would not have admitted, and
 * narrowing the parameter would make the rejection unreachable.
 * @param keys - keys a caller asked to send, straight from the Remote boundary.
 * @returns the first inadmissible key, or `undefined` when all are admitted.
 */
export function invalidKey(keys: readonly string[]): string | undefined {
  return keys.find(key => !HERDR_KEYS.some(admitted => admitted === key))
}
