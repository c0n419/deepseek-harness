# Herdr

English | [中文](herdr.zh.md)

`ctx.herdr` connects a running [Herdr](../../packages/experimental/herdr/README.md) terminal multiplexer to the harness: one Client-facing view of the server's workspaces, tabs, panes, and recognized agents, plus the read, prompt, send-keys, and focus commands. The [Web panel](../../packages/experimental/client-ui-herdr/README.md) renders that view, and the [optional bundle](../../packages/experimental/herdr-bundle/README.md) composes the service with the panel, switched off until someone enables it.

## Ownership and data path

Herdr's server owns its workspaces, tabs, panes, and agents as one process-global resource outside any Session. The service therefore publishes them as a Remote stream rather than Session data: `watch()` yields the current view first and then every coalesced change, the Client re-subscribes after a reload, and nothing is persisted. Pane text is not part of the stream; only the pane a watcher displays is read, through `pane.read` with soft wraps joined.

Every command addresses a pane, not an agent name. `focus(paneId)` and `sendKeys(paneId, keys)` drive that pane through the server's `pane.focus` and `pane.send_keys`, so a pane running no agent is still focusable and still accepts keys; `prompt(paneId, text)` goes to `agent.prompt`, which the server answers with `agent_not_found` for a pane no agent occupies. `sendText(paneId, text)` types raw terminal input — the bytes a terminal emulator emits for keystrokes — through `pane.send_text`, and refuses a payload above `maxInputBytes` as `input_too_large` without forwarding any of it. `prompt`, `sendKeys`, `sendText`, and `focus` return either success or a refusal code with its message, so a panel renders `agent_not_found`, `blocked`, or a rejected key as an ordinary state instead of a failure. `read(paneId)` returns the pane's recent rows with their color sequences plus the pane's column count from `pane.layout`, so a terminal renderer wraps exactly as the pane does; it reports a vanished pane as `notFound`, which is a normal race, and its line budget is the `readLines` field. `sendKeys` admits a fixed key set — Escape, Ctrl+C, Enter, Up, Down, Y, and N — checked before any byte reaches the pane.

## Transport and connection state

The service dials the server's AF_UNIX socket directly and never spawns the `herdr` CLI. The server answers exactly one request per connection, so each unary call opens its own connection, while one long-lived `events.subscribe` connection pushes the events that trigger a re-read; a subscription the server accepts but never confirms is closed and retried within `requestTimeoutMs`, so the service cannot sit on a half-open socket while reporting itself connected.

Pushed events do not each cost a re-read. Every event schedules one re-read after the `outputCoalesceMs` window, and a request that arrives while a re-read is in flight is served by the trailing window instead of opening a second pair of connections — `pane.updated` fires on every agent-pane redraw, so a burst becomes one snapshot. A plain shell that prints pushes no event and keeps its revision, so a panel follows its shown pane by re-reading it every `outputRefreshMs`, which each view carries.

Protocol number and server version are verified on connect; a mismatch publishes `incompatible` with both numbers instead of proceeding against unknown frames, and an absent or unreadable socket publishes `unavailable` with the reason. An outage keeps retrying with bounded backoff, because Herdr normally starts after the harness, and both states are view data the panel renders, so an optional bundle whose server is not running leaves the harness composition intact. A protocol mismatch is terminal rather than retried: the loop stops, and the next `watch()` — which is what the panel's Retry opens — re-probes the server, so an upgraded server recovers without a page reload.

Topology events are global, while the per-pane agent-state event requires a `pane_id`; the subscription is therefore rebuilt when the pane set changes, so a pane created later still reports its transitions.

## Configuration

`socketPath` selects the API socket; omission resolves `HERDR_SOCKET_PATH` and then the default session's socket under the Herdr config directory, and a relative configured path fails at construction. `requestTimeoutMs`, `reconnectInitialMs`, `reconnectMaxMs`, `maxFrameBytes`, `readLines`, `outputCoalesceMs`, `outputRefreshMs`, and `maxInputBytes` bound the transport, the retry schedule, the re-read window, the panel's refresh interval, and one typed-input payload, and `expectedProtocol` names the socket protocol this build speaks.

## Design rationale

The [Herdr state decision](../../.agents/notes/implemented/architecture/2026-10-08-herdr-state-remote-stream.md) explains why the view is a host Remote stream rather than Session events, and what the alternatives cost.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxherdr--herdrservice"></a>

### `ctx.herdr` — `HerdrService`

Host-side Herdr service.

The connection is established lazily on the first watch or command, because a deployment may compose the plugin before Herdr starts; a load-time dial would make the harness's startup order a correctness requirement.

```ts cordis-catalog
/**
 * Watch the server's live state: the current view, then every coalesced
 * change, until the Client stops watching.
 * @param signal - carrier cancellation.
 * @returns every frame the stream publishes, current view first.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<HerdrView>

/**
 * Read one pane's recent output as terminal rows with their colors, plus the
 * pane's column count so a renderer wraps exactly as the pane does. The
 * server pushes no text, so this stays a lazy read of the pane a caller displays.
 *
 * The line budget is `readLines` from configuration rather than a parameter:
 * an optional Remote parameter is not expressible through the generated
 * descriptor, so a caller could not omit it.
 * @param paneId - pane to read.
 * @returns the pane's text, or `{notFound: true}` when the pane is gone.
 */
@Remote async read(paneId: HerdrPaneId): Promise<HerdrReadResult>

/**
 * Type raw terminal input into a pane: the bytes a terminal emulator emits for
 * keystrokes, arrows, and control characters, delivered through
 * `pane.send_text` unchanged. A payload above `maxInputBytes` is refused as a
 * result, never forwarded in part.
 * @param paneId - pane receiving the input.
 * @param text - raw input, including escape sequences.
 * @returns success, `input_too_large`, or the server's refusal code.
 */
@Remote async sendText(paneId: HerdrPaneId, text: string): Promise<HerdrCommandResult>

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
@Remote async prompt(paneId: HerdrPaneId, text: string): Promise<HerdrCommandResult>

/**
 * Send logical keys to a pane. `pane.send_keys` addresses the pane itself, so
 * a shell without an agent accepts keys exactly as an agent's pane does.
 * @param paneId - pane to receive the keys.
 * @param keys - keys to send, restricted to the surface's allowlist.
 * @returns success, or an error result naming the rejected key.
 */
@Remote async sendKeys(paneId: HerdrPaneId, keys: readonly HerdrKey[]): Promise<HerdrCommandResult>

/**
 * Focus one pane, making it the server's focused pane.
 *
 * `pane.focus` addresses the pane directly, so every pane is focusable,
 * including a shell that hosts no agent.
 * @param paneId - pane to focus.
 * @returns success, or the server's refusal code.
 */
@Remote async focus(paneId: HerdrPaneId): Promise<HerdrCommandResult>

/**
 * Close the service: stop reconnecting, close the subscription, and await the
 * connection's release. Idempotent; later calls throw the recorded reason.
 * @returns after the subscription connection is closed.
 */
async dispose(): Promise<void>
```

Source: [`packages/experimental/herdr/src/index.ts`](../../packages/experimental/herdr/src/index.ts)
<!-- END GENERATED cordis-surface -->
