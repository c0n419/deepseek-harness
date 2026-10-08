/**
 * Host-side Herdr service: one Client-facing view of a Herdr server's
 * workspaces, tabs, panes, and recognized agents, plus the v1 command surface.
 *
 * The service owns the process-global Herdr session, so its state is a Remote
 * stream rather than session data: a reload re-subscribes and nothing is
 * persisted. It dials the AF_UNIX socket directly and never spawns the `herdr`
 * CLI — bare `herdr` launches a TUI and the CLI auto-spawns a server daemon,
 * neither of which an integration should cause.
 *
 * Bootstrap is one `session.snapshot`; maintenance is an `events.subscribe`
 * connection whose pushed events trigger a re-read. Pane text is not pushed at
 * all, so it is read lazily for the pane a watcher displays.
 * @module @deepseek-ai/dsh-experimental-herdr
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { HerdrClient, isRefusal } from './connection.ts'
import type { HerdrCallResult } from './connection.ts'
import { asError, connectionOf, invalidKey, parseRead, parseSnapshot, viewSubscriptions } from './protocol.ts'
import type { ParsedView } from './protocol.ts'
import type {
  HerdrCommandResult, HerdrConnection, HerdrKey, HerdrPaneId, HerdrReadResult, HerdrReadSource,
  HerdrView,
} from './types.ts'

/** The server speaks a protocol this build cannot use; retrying cannot help. */
class HerdrIncompatibleError extends Error {
  /**
   * @param expected - protocol number this build speaks.
   * @param actual - protocol number the server reported.
   */
  constructor(readonly expected: number, readonly actual: number) {
    super(`herdr: server speaks protocol ${String(actual)}, this build requires ${String(expected)}; update one of them`)
    this.name = 'HerdrIncompatibleError'
  }
}

export type * from './types.ts'
export { HerdrAgentName, HerdrPaneId, HerdrTabId, HerdrWorkspaceId } from './brand.ts'
export { HerdrProtocolError } from './protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side Herdr socket service. */
    herdr: HerdrService
  }
}

/** Protocol number this build speaks; verified against the server on connect. */
const EXPECTED_PROTOCOL = 20

/** Default request budget, in milliseconds; a local socket round trip is sub-millisecond. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/** Default ceiling for one reply or event line, in bytes. */
const DEFAULT_MAX_FRAME_BYTES = 1_048_576

/** Default first reconnect delay after a dropped stream, in milliseconds. */
const DEFAULT_RECONNECT_INITIAL_MS = 250

/** Default reconnect ceiling, in milliseconds. */
const DEFAULT_RECONNECT_MAX_MS = 5_000

/** Default line budget a lazy pane read asks for. */
const DEFAULT_READ_LINES = 400

/** Default window the stream coalesces updates within, in milliseconds. */
const DEFAULT_OUTPUT_COALESCE_MS = 120

/** Default interval a panel re-reads its selected pane at, in milliseconds. */
const DEFAULT_OUTPUT_REFRESH_MS = 1_000

/** Plugin configuration: everything a deployment may vary. */
export interface Config {
  /**
   * Absolute path of the Herdr API socket. Omission resolves
   * `HERDR_SOCKET_PATH`, then the default session's socket under the Herdr
   * config directory.
   */
  socketPath?: string
  /** Wall-clock budget for one request/response round trip, in milliseconds; omission defaults to 10000. */
  requestTimeoutMs?: number
  /** Protocol number this build speaks; a mismatch reports `incompatible` instead of proceeding; omission defaults to 20. */
  expectedProtocol?: number
  /** First reconnect delay after a dropped event stream, in milliseconds; omission defaults to 250. */
  reconnectInitialMs?: number
  /** Reconnect delay ceiling, in milliseconds; omission defaults to 5000. */
  reconnectMaxMs?: number
  /** Maximum accepted bytes of one reply or event line; omission defaults to 1048576. */
  maxFrameBytes?: number
  /** Lines a lazy pane read requests; omission defaults to 400. */
  readLines?: number
  /** Milliseconds view updates are coalesced within, so a busy pane cannot flood the Client; omission defaults to 120. */
  outputCoalesceMs?: number
  /**
   * Milliseconds between re-reads of the pane a panel shows. Herdr pushes no
   * event when a plain shell prints, so a shown pane follows its output by
   * re-reading; omission defaults to 1000.
   */
  outputRefreshMs?: number
}

/**
 * Resolve the socket path this deployment wants: the configured path, then the
 * environment override, then the default session's location. Explicit at the
 * package boundary, so no caller inherits a hidden fallback.
 * @param config - the plugin's configuration as written in `cordis.yml`.
 * @param env - environment to read the override from; the service passes `process.env`.
 * @returns the absolute socket path to dial.
 * @throws Error when a configured path is relative, which `connect` would resolve against the working directory.
 */
export function resolveSocketPath(config: Pick<Config, 'socketPath'>, env: NodeJS.ProcessEnv): string {
  const configured = config.socketPath ?? env.HERDR_SOCKET_PATH
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error(`herdr: socketPath must be absolute, received ${configured}`)
    return configured
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configHome, 'herdr', 'herdr.sock')
}

/** Configuration with every numeric default applied; only the socket path stays optional. */
type Resolved = Required<Omit<Config, 'socketPath'>>

/** One connected watcher of the view stream. */
interface Watcher {
  /** Latest view this watcher has been handed. */
  view: HerdrView
  /** Wakes an iteration waiting for the next frame. */
  notify: () => void
  /** Waits for the next frame and applies the coalescing window. */
  next: () => Promise<void>
  /** Releases the watcher's single abort listener on the caller's signal. */
  dispose: () => void
}

/**
 * Validate one numeric field. Misconfiguration fails loud at construction rather
 * than producing a timer or socket that misbehaves later.
 * @param value - configured value.
 * @param name - field name for the failure message.
 * @returns the same value when it is a positive integer.
 * @throws Error when the value is not a positive integer.
 */
function requirePositive(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`herdr: ${name} must be a positive integer, received ${String(value)}`)
  return value
}

/** Assemble one view frame from a connection state, a decoded list set, and the panel refresh interval. */
function viewOf(connection: HerdrConnection, lists: ParsedView, outputRefreshMs: number): HerdrView {
  return {
    connection,
    outputRefreshMs,
    workspaces: lists.workspaces,
    tabs: lists.tabs,
    panes: lists.panes,
    agents: lists.agents,
    ...lists.focusedPaneId === undefined ? {} : { focusedPaneId: lists.focusedPaneId },
  }
}

/**
 * Host-side Herdr service.
 *
 * The connection is established lazily on the first watch or command, because a
 * deployment may compose the plugin before Herdr starts; a load-time dial would
 * make the harness's startup order a correctness requirement.
 */
export default class HerdrService extends TypertRemoteService {
  static inject: string[] = []

  static Config: z<Config> = z.object({
    socketPath: z.string(),
    requestTimeoutMs: z.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
    expectedProtocol: z.number().default(EXPECTED_PROTOCOL),
    reconnectInitialMs: z.number().default(DEFAULT_RECONNECT_INITIAL_MS),
    reconnectMaxMs: z.number().default(DEFAULT_RECONNECT_MAX_MS),
    maxFrameBytes: z.number().default(DEFAULT_MAX_FRAME_BYTES),
    readLines: z.number().default(DEFAULT_READ_LINES),
    outputCoalesceMs: z.number().default(DEFAULT_OUTPUT_COALESCE_MS),
    outputRefreshMs: z.number().default(DEFAULT_OUTPUT_REFRESH_MS),
  })

  private readonly config: Resolved
  private readonly socketPath: string
  private readonly client: HerdrClient
  private readonly watchers = new Set<Watcher>()
  private connection: HerdrConnection = { status: 'unavailable', reason: 'not connected yet' }
  private lists: ParsedView = { workspaces: [], tabs: [], panes: [], agents: [] }
  private subscribedPanes: HerdrPaneId[] = []
  private stream: { close: () => void } | undefined
  private started: Promise<void> = Promise.resolve()
  private reconnect: ReturnType<typeof setTimeout> | undefined
  private reconnectDelay: number
  private wake: (() => void) | undefined
  private generation = 0
  private disposal: Promise<void> | undefined
  private stopped = false
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshing: Promise<void> | undefined
  /** Whether the memoized start ended without a live subscription, so the next caller must restart. */
  private ended = true
  /** Identifies the live start generation; a superseded one stops retrying. */
  private startToken = 0

  /**
   * @param ctx - owning Cordis Context.
   * @param config - plugin configuration; the schema fills every omitted default.
   * @throws Error when a numeric field is not a positive integer or the socket path is not absolute.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'herdr', { namespace: 'herdr' })
    // The schema supplies every numeric default before construction; these
    // validations cover a direct construction that bypassed it.
    this.config = config as Resolved
    requirePositive(this.config.requestTimeoutMs, 'requestTimeoutMs')
    requirePositive(this.config.expectedProtocol, 'expectedProtocol')
    requirePositive(this.config.reconnectInitialMs, 'reconnectInitialMs')
    requirePositive(this.config.reconnectMaxMs, 'reconnectMaxMs')
    requirePositive(this.config.maxFrameBytes, 'maxFrameBytes')
    requirePositive(this.config.readLines, 'readLines')
    requirePositive(this.config.outputCoalesceMs, 'outputCoalesceMs')
    requirePositive(this.config.outputRefreshMs, 'outputRefreshMs')
    this.socketPath = resolveSocketPath(config, process.env)
    this.reconnectDelay = this.config.reconnectInitialMs
    this.client = new HerdrClient({
      socketPath: this.socketPath,
      requestTimeoutMs: this.config.requestTimeoutMs,
      maxFrameBytes: this.config.maxFrameBytes,
    })
  }

  /**
   * Watch the server's live state: the current view, then every coalesced
   * change, until the Client stops watching.
   * @param signal - carrier cancellation.
   * @returns every frame the stream publishes, current view first.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<HerdrView> {
    const watcher = this.attach(signal)
    this.watchers.add(watcher)
    try {
      void this.ensureStarted()
      // A watcher always receives the current view first, connected or not, so a
      // Client never renders from a stale cache while the first connect is in flight.
      yield watcher.view
      do {
        await watcher.next()
        yield watcher.view
      } while (!signal.aborted)
    } finally {
      // Removal cannot depend on the consumer draining the generator: a Client
      // that aborts and stops reading never reaches code after the loop, and
      // every such Retry would otherwise leak a watcher that publish() iterates.
      watcher.dispose()
      this.watchers.delete(watcher)
    }
  }

  /**
   * Read one pane's recent text with soft wraps joined. The server pushes no
   * text, so this stays a lazy read of the pane a caller displays.
   *
   * The line budget is `readLines` from configuration rather than a parameter:
   * an optional Remote parameter is not expressible through the generated
   * descriptor, so a caller could not omit it.
   * @param paneId - pane to read.
   * @returns the pane's text, or `{notFound: true}` when the pane is gone.
   */
  @Remote
  async read(paneId: HerdrPaneId): Promise<HerdrReadResult> {
    const source: HerdrReadSource = 'recent_unwrapped'
    const outcome = await this.invoke('pane.read', {
      pane_id: paneId,
      source,
      lines: this.config.readLines,
    })
    if (isRefusal(outcome)) {
      if (outcome.code === 'pane_not_found') return { notFound: true }
      throw new Error(`herdr: pane.read failed: ${outcome.message}`)
    }
    return parseRead(paneId, outcome.result)
  }

  /**
   * Submit one prompt to the agent occupying a pane.
   *
   * `agent.prompt` addresses an agent, so a pane with no recognized agent is a
   * result (`agent_not_found`), never a throw: the caller asked about a pane and
   * the answer is that the pane has no agent to prompt.
   * @param paneId - pane whose agent receives the prompt.
   * @param text - prompt text, submitted with an encoded Enter.
   * @returns success, or the server's refusal code (`agent_blocked`, `agent_not_found`, …).
   */
  @Remote
  async prompt(paneId: HerdrPaneId, text: string): Promise<HerdrCommandResult> {
    return await this.command('agent.prompt', { target: paneId, text })
  }

  /**
   * Send logical keys to a pane. `pane.send_keys` addresses the pane itself, so
   * a shell without an agent accepts keys exactly as an agent's pane does.
   * @param paneId - pane to receive the keys.
   * @param keys - keys to send, restricted to the surface's allowlist.
   * @returns success, or an error result naming the rejected key.
   */
  @Remote
  async sendKeys(paneId: HerdrPaneId, keys: readonly HerdrKey[]): Promise<HerdrCommandResult> {
    // The Remote boundary is a JSON boundary, so the check takes the raw string
    // form: `readonly HerdrKey[]` widens to `readonly string[]` implicitly, which
    // is exactly the unchecked value the allowlist exists to reject.
    const rejected = invalidKey(keys)
    if (rejected !== undefined) {
      return { ok: false, code: 'invalid_key', message: `herdr: key ${rejected} is not on the command surface` }
    }
    return await this.command('pane.send_keys', { pane_id: paneId, keys })
  }

  /**
   * Focus one pane, making it the server's focused pane.
   *
   * `pane.focus` addresses the pane directly, so every pane is focusable,
   * including a shell that hosts no agent.
   * @param paneId - pane to focus.
   * @returns success, or the server's refusal code.
   */
  @Remote
  async focus(paneId: HerdrPaneId): Promise<HerdrCommandResult> {
    return await this.command('pane.focus', { pane_id: paneId })
  }

  /**
   * Close the service: stop reconnecting, close the subscription, and await the
   * connection's release. Idempotent; later calls throw the recorded reason.
   * @returns after the subscription connection is closed.
   */
  async dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    await this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.stopped = true
    clearTimeout(this.reconnect)
    this.reconnect = undefined
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    this.wake?.()
    this.client.close('the service was disposed')
    this.stream?.close()
    this.stream = undefined
    this.connection = { status: 'unavailable', reason: 'the service was disposed' }
    this.publish()
    // The startup loop exits on its own once `stopped` is set; a dial that is
    // still in flight must not hold disposal open.
    await this.started
  }

  /**
   * Connect once: verify the protocol, take the bootstrap snapshot, then open
   * the subscription. A failure is published as the view's connection state and
   * retried with bounded backoff, so a server started later is picked up.
   *
   * Single-flight: an in-flight start is joined rather than duplicated, and an
   * ended generation is superseded only once that start settles. Two concurrent
   * `connect()` runs would each open a subscription, and the second would
   * overwrite the tracked handle, leaving the first live but unreachable by
   * {@link dispose}.
   */
  private ensureStarted(): Promise<void> {
    if (this.stopped || !this.ended) return this.started
    this.ended = false
    const token = ++this.startToken
    // A superseded start stops retrying at its next check, so chaining on it
    // cannot wait out a backoff; waking its current wait makes that immediate.
    const previous = this.started
    this.wake?.()
    const started = Promise.resolve(previous).then(async () => { await this.startSession(token) })
    this.started = started
    return started
  }

  private async startSession(token: number): Promise<void> {
    while (!this.stopped && this.startToken === token) {
      try {
        await this.connect()
        this.reconnectDelay = this.config.reconnectInitialMs
        return
      } catch (error: unknown) {
        if (error instanceof HerdrIncompatibleError) {
          // A protocol mismatch is a version incompatibility, not a transient
          // outage, so the retry loop ends rather than spinning. `connect()`
          // already published the `incompatible` state; `ended` makes the next
          // watch re-probe, so a server upgrade recovers without a page reload.
          this.ended = true
          this.wake?.()
          return
        }
        const reason = asError(error).message
        this.connection = { status: 'unavailable', reason }
        this.publish()
        await this.waitBeforeReconnect()
      }
    }
    // Only the live generation owns `ended`: a superseded one leaves the flag to
    // its successor, which is the start actually in flight.
    /* v8 ignore next -- superseding a retrying start needs a stream failure on a
       live subscription, and a live subscription means that start settled. */
    if (this.startToken === token) this.ended = true
  }

  /**
   * Wait out the current backoff, doubling it for the next attempt. Disposal
   * wakes this immediately so a shutdown never waits on a retry timer.
   */
  private async waitBeforeReconnect(): Promise<void> {
    // Disposal may have begun while a request was in flight, so the wait must be
    // re-checked here and not only in the loop that called it.
    if (this.stopped) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(delay * 2, this.config.reconnectMaxMs)
    await new Promise<void>((resolve) => {
      this.wake = resolve
      this.reconnect = setTimeout(() => {
        this.reconnect = undefined
        resolve()
      }, delay)
    })
    this.wake = undefined
  }

  private async connect(): Promise<void> {
    const connection = connectionOf(this.config.expectedProtocol, await this.request('ping', {}))
    if (connection.status === 'incompatible') {
      // Never silently proceed against a protocol this build does not speak.
      this.connection = connection
      this.publish()
      throw new HerdrIncompatibleError(connection.expected, connection.actual)
    }
    this.lists = parseSnapshot(await this.request('session.snapshot', {}))
    this.connection = connection
    this.publish()
    this.client.observe({
      event: () => { this.scheduleRefresh() },
      failed: (error) => { this.streamFailed(error) },
    })
    this.subscribedPanes = this.lists.panes.map(pane => pane.paneId)
    this.stream = { close: await this.client.subscribe(viewSubscriptions(this.subscribedPanes), () => {}) }
    // A pane whose state changed while the stream was opening would otherwise
    // stay stale until its next transition.
    this.scheduleRefresh()
  }

  /**
   * Handle a dead stream: publish the failure, then reconnect unless the service
   * is disposing. The subscription is the view's only source of updates, so a
   * stream that ended is always fatal to the current generation.
   */
  private streamFailed(error: Error): void {
    // Close the connection the failure refers to before any restart, so the
    // tracked handle always names the only live subscription.
    this.stream?.close()
    this.stream = undefined
    /* v8 ignore next -- a real stream close can race disposal: `stopped` is set
       before the subscription socket is closed, so this arm needs a timer to land
       between the two. */
    if (this.stopped) return
    this.connection = { status: 'unavailable', reason: error.message }
    this.publish()
    this.ended = true
    void this.ensureStarted()
  }

  /**
   * Request a re-read after the coalescing window. A burst of pushed events
   * therefore costs one re-read, not one per event: `pane.updated` fires on
   * every output flush, and each re-read is two fresh connections.
   */
  private scheduleRefresh(): void {
    if (this.stopped || this.refreshTimer !== undefined) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refresh()
    }, this.config.outputCoalesceMs)
  }

  /**
   * Re-read the whole view once. Every pushed event schedules this: an event
   * carries one pane's state, and one cheap local snapshot call also covers
   * topology changes the event payload omits. Concurrent callers join the
   * in-flight read instead of starting a second pair of connections; a request
   * that arrives during a read is served by the trailing `scheduleRefresh`.
   */
  private async refresh(): Promise<void> {
    this.refreshing ??= this.refreshOnce()
    try {
      await this.refreshing
    } finally {
      this.refreshing = undefined
    }
  }

  private async refreshOnce(): Promise<void> {
    try {
      const [pong, snapshot] = [await this.request('ping', {}), await this.request('session.snapshot', {})]
      const connection = connectionOf(this.config.expectedProtocol, pong)
      this.lists = parseSnapshot(snapshot)
      this.connection = connection
      this.publish()
      await this.resubscribeIfPanesChanged()
    } catch (error: unknown) {
      this.connection = { status: 'unavailable', reason: asError(error).message }
      this.publish()
      this.stream?.close()
      this.stream = undefined
      this.ended = true
      void this.ensureStarted()
    }
  }

  /**
   * Re-subscribe when the pane set changed: `pane.agent_status_changed` needs a
   * `pane_id` per pane and has no global form, so a new pane's transitions would
   * otherwise never arrive.
   */
  private async resubscribeIfPanesChanged(): Promise<void> {
    const current = this.lists.panes.map(pane => pane.paneId)
    if (current.length === this.subscribedPanes.length && current.every(id => this.subscribedPanes.includes(id))) return
    const previous = this.stream
    this.subscribedPanes = current
    this.stream = { close: await this.client.subscribe(viewSubscriptions(current), () => {}) }
    previous?.close()
  }

  private publish(): void {
    this.generation += 1
    const view = viewOf(this.connection, this.lists, this.config.outputRefreshMs)
    for (const watcher of this.watchers) {
      watcher.view = view
      watcher.notify()
    }
  }

  private attach(signal: AbortSignal): Watcher {
    // One abort listener for the whole watcher lifetime. A listener per frame
    // accumulates on the caller's long-lived carrier signal and never clears.
    // `wake` is the single waiter — either the frame wait or the coalescing
    // window — so one listener covers both and the window needs no second one.
    let wake: (() => void) | undefined
    let delivered = this.generation
    // Abort removes the watcher itself: a consumer that stops reading never
    // resumes the generator, so cleanup cannot wait on its `finally`.
    const onAbort = (): void => {
      wake?.()
      this.watchers.delete(watcher)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const watcher: Watcher = {
      view: viewOf(this.connection, this.lists, this.config.outputRefreshMs),
      notify: (): void => { wake?.() },
      dispose: (): void => { signal.removeEventListener('abort', onAbort) },
      next: async (): Promise<void> => {
        while (!signal.aborted && this.generation === delivered) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = undefined
        }
        if (signal.aborted) return
        // Coalescing window: a burst of events inside it becomes one frame, and
        // a change during the wait is picked up by the next pass of the loop.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.config.outputCoalesceMs)
          wake = (): void => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = undefined
        delivered = this.generation
      },
    }
    return watcher
  }

  private async command(method: string, params: Record<string, unknown>): Promise<HerdrCommandResult> {
    const outcome = await this.invoke(method, params)
    return isRefusal(outcome)
      ? { ok: false, code: outcome.code, message: outcome.message }
      : { ok: true }
  }

  private async invoke(method: string, params: Record<string, unknown>): Promise<HerdrCallResult> {
    void this.ensureStarted()
    return await this.client.call(method, params)
  }

  /**
   * One unary call whose refusal is an exception. Reserved for the service's own
   * bootstrap and refresh, where a refused request is a failure of that
   * operation rather than a result a caller asked about.
   */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const outcome = await this.client.call(method, params)
    if (isRefusal(outcome)) throw new Error(`herdr: ${method} refused: ${outcome.code}: ${outcome.message}`)
    return outcome.result
  }
}
