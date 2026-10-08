/**
 * Client-safe vocabulary of the Herdr socket service: the view a watcher
 * receives, the command results, and the branded handles that cross the Remote
 * boundary. Nothing here is protocol-specific; the AF_UNIX wire spelling stays
 * in `protocol.ts`.
 * @module @deepseek-ai/dsh-experimental-herdr/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque `w<N>` workspace handle. */
export type HerdrWorkspaceId = Branded<'HerdrWorkspaceId'>

/** Opaque `w<N>:t<N>` tab handle. */
export type HerdrTabId = Branded<'HerdrTabId'>

/** Opaque `w<N>:p<N>` pane handle. */
export type HerdrPaneId = Branded<'HerdrPaneId'>

/** A live agent name, unique among the agents of one Herdr server. */
export type HerdrAgentName = Branded<'HerdrAgentName'>

/**
 * Agent lifecycle state. `done` is a server-side "ready and finished" state that
 * only the server's seen bookkeeping distinguishes from `idle`; `unknown` means
 * an agent is present but unclassifiable, never that it finished.
 */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

/** Which server-side buffer a text read comes from. */
export type HerdrReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection'

/**
 * Logical keys the command surface admits. This is the single source of truth:
 * the {@link HerdrKey} union derives from it, and the runtime check reads it, so
 * the type and the allowlist cannot drift.
 */
export const HERDR_KEYS = ['esc', 'ctrl+c', 'enter', 'up', 'down', 'y', 'n'] as const

/**
 * One key the command surface admits, checked before any byte is written.
 * The set is deliberately closed: the panel's controls are the whole v1 surface.
 */
export type HerdrKey = (typeof HERDR_KEYS)[number]

/** One workspace of the server's live session. */
export interface HerdrWorkspace {
  /** Opaque workspace handle. */
  workspaceId: HerdrWorkspaceId
  /** Display label; the server derives it from the workspace's directory when unset. */
  label: string
  /** Whether the server currently has this workspace focused. */
  focused: boolean
  /** Number of tabs in this workspace. */
  tabCount: number
  /** Number of panes in this workspace. */
  paneCount: number
  /** Aggregate agent state across the workspace's panes. */
  agentStatus: HerdrAgentStatus
}

/** One tab of one workspace. */
export interface HerdrTab {
  /** Opaque tab handle. */
  tabId: HerdrTabId
  /** Owning workspace. */
  workspaceId: HerdrWorkspaceId
  /** Display label. */
  label: string
  /** Whether the server currently has this tab focused. */
  focused: boolean
  /** Number of panes in this tab. */
  paneCount: number
  /** Aggregate agent state across the tab's panes. */
  agentStatus: HerdrAgentStatus
}

/** One pane, whether or not an agent occupies it. */
export interface HerdrPane {
  /** Opaque pane handle. */
  paneId: HerdrPaneId
  /** Owning workspace. */
  workspaceId: HerdrWorkspaceId
  /** Owning tab. */
  tabId: HerdrTabId
  /** Whether the server currently has this pane focused. */
  focused: boolean
  /** Pane state as reported by the server. */
  agentStatus: HerdrAgentStatus
  /**
   * Server-side pane revision. It advances with agent state changes, not with
   * every byte of output: a plain shell that prints keeps its revision.
   */
  revision: number
  /** Live agent name, when Herdr recognized one in this pane. */
  agent?: HerdrAgentName
  /** Working directory of the pane's foreground process. */
  foregroundCwd?: string
  /** Terminal title as rendered, including any state glyph. */
  terminalTitle?: string
}

/** One pane that Herdr recognized as hosting an agent. */
export interface HerdrAgent {
  /** The agent's pane. */
  paneId: HerdrPaneId
  /** Owning workspace. */
  workspaceId: HerdrWorkspaceId
  /** Owning tab. */
  tabId: HerdrTabId
  /** Live agent name; absent for an unnamed agent. */
  name?: HerdrAgentName
  /** Agent kind label as Herdr detected it (`omp`, `claude`, …). */
  agent?: string
  /** Lifecycle state. */
  agentStatus: HerdrAgentStatus
  /** Whether the agent is at an interactive prompt and can accept input. */
  interactiveReady: boolean
  /** Whether Herdr is still waiting for the agent to appear in the pane. */
  launchPending: boolean
  /** Whether the server currently has this agent's pane focused. */
  focused: boolean
}

/** How the service currently reaches the Herdr server. */
export type HerdrConnection =
  | { status: 'connected'; version: string; protocol: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'incompatible'; expected: number; actual: number }

/** One complete frame of the watch stream. */
export interface HerdrView {
  /** Current reachability of the server. */
  connection: HerdrConnection
  /** Milliseconds between re-reads of a shown pane, from the service's `outputRefreshMs`. */
  outputRefreshMs: number
  /** Every workspace of the server's live session. */
  workspaces: HerdrWorkspace[]
  /** Every tab of those workspaces. */
  tabs: HerdrTab[]
  /** Every pane of those tabs. */
  panes: HerdrPane[]
  /** Every pane Herdr recognized as hosting an agent. */
  agents: HerdrAgent[]
  /** The server's focused pane, when it has one. */
  focusedPaneId?: HerdrPaneId
}

/** One pane's text as the server returned it. */
export interface HerdrRead {
  /** The pane the text came from. */
  paneId: HerdrPaneId
  /** Requested text with soft wraps joined by default. */
  text: string
  /** Pane revision this text was read at. */
  revision: number
  /** Whether the server trimmed the text to the requested line budget. */
  truncated: boolean
}

/** A read whose pane no longer exists: a normal race, not a failure. */
export interface HerdrReadNotFound {
  /** Discriminant of an absent pane. */
  notFound: true
}

/** Result of a text read. */
export type HerdrReadResult = HerdrRead | HerdrReadNotFound

/** A command the server refused. */
export interface HerdrCommandError {
  /** Discriminant of a refused command. */
  ok: false
  /** Server error code (`agent_not_found`, `agent_blocked`, `timeout`, …). */
  code: string
  /** Server error message. */
  message: string
}

/** Result of a command that accepts no other value on success. */
export type HerdrCommandResult = { ok: true } | HerdrCommandError
