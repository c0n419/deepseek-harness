# Agent Note: Herdr state reaches the GUI through a host Remote stream

Status: implemented

English | [中文](2026-10-08-herdr-state-remote-stream.zh.md)

## Problem

Herdr is a terminal multiplexer that runs coding agents in tmux-like tabs and panes, and its server owns workspace, tab, pane, and agent state as one process-global resource outside any harness session. Several panes may run harness sessions, and the server changes state without harness involvement. A Web panel needs that state continuously: a workspace/tab/pane tree with per-agent status, the selected pane's output, and commands that prompt an agent, send keys, or move focus.

The harness already carries one mechanism that binds plugin state to the GUI: session events written to the log, folded by a session projection and served to the Client. It fits state that one session owns and that must survive replay. Herdr state is neither: it belongs to a separate server, changes without a session, and includes unbounded pane text. Recording it as session events would add `SessionEventMap` members for facts no session produces, grow the log at the rate of terminal output, force the persistence acknowledgement and the TypeScript and Python SDK expected outputs that an event member implies, and bind a global resource to one session's lifetime.

## Decision

Herdr state reaches the GUI through a host-only Typert Remote stream backed by a direct socket client, never through session projections or session events. The host package owns one Cordis service keyed `ctx.herdr`, which is the only place herdr state lives; the client plugin contributes the panel and mounts the generated Remote namespace.

### Host and Client data path

The service extends `TypertRemoteService`, following the remote-method and duplex-stream rules of the [remote method calls](2026-08-02-typert-remote-method-calls.md) and [duplex stream](2026-09-19-remote-duplex-stream.md) decisions. `@Remote({ mode: 'stream' }) watch(signal)` yields a full view per frame; the optional `signal` is the reserved final parameter of a stream method and is appended by the Gateway. The view carries the connection state, the workspace, tab, pane, and agent rows, and the focused pane id. Unary `@Remote` methods carry the commands: `read`, `prompt`, `sendKeys`, and `focus`. A command failure is a result value with a code and message, not a thrown error, so the Client renders `not_found`, `blocked`, and `timeout` as ordinary states.

Pane text is not part of the stream. The Client asks `read` for the pane the person selected and re-reads on that pane's update, so an idle panel never moves terminal output over the wire. The stream sends a complete view per frame and coalesces rapid updates, so a Client that reconnects or reloads re-subscribes and needs no replay.

### Socket transport and lifetime

The service dials the herdr server's UNIX domain socket directly with newline-delimited JSON, one request per connection, and holds one long-lived subscription connection. It never spawns the `herdr` command at runtime: the CLI's default action is the interactive multiplexer, and a spawned process would add terminal ownership and lifecycle questions the socket protocol does not have. Bootstrap is one `session.snapshot` request; updates arrive from the existing `events.subscribe` subscription; a dropped socket reconnects with bounded backoff and republishes the view.

Connection state is part of the view, not a failure: `connected` carries the server version and protocol number, `unavailable` covers an absent or unreadable socket, and `incompatible` names the expected and actual protocol. A startup failure leaves the service in a degraded state that the panel renders, because an optional bundle that cannot reach its server must not fail the host composition.

### Configuration and deployment

Socket path, request timeout, expected protocol, reconnect bounds, frame byte cap, read line count, and output coalescing are validated `Config` fields, and the socket path resolves through an explicit `resolveSocketPath(config, env)` step rather than a hidden default inside a call. The bundle ships switched off through `OPTIONAL_BUNDLES`, so a person enables herdr from the plugin manager and an installation without the server carries only the socket client.

## Alternatives considered

**Session events with a session projection.** The mechanism the harness already has, and the Client needs no new API. Rejected because pane text is unbounded and the log is durable: every frame would become a persisted event, and the projection would need a fold for state the session does not own. It also implies `SessionEventMap` members, persistence format acknowledgement, and both SDK expected outputs for a resource that exists outside the log, and a replay would show history that need not match the live server.

**A session-scoped Remote with one socket per session.** Each session gets its own herdr client and its own workspace list. Rejected because the server owns the panes, so two sessions would hold divergent copies of one global fact, and closing a session would close a connection other panes depend on.

**Model-facing tools only, with no GUI stream.** Cheaper: the model reads and drives panes through tools, and the person watches the herdr TUI. Rejected because the point of the Web panel is to see agent status and pane output without leaving the harness, and tools would still need session events for every model-visible read.

**Spawn the `herdr` CLI per operation.** Reuses the CLI's own transport and needs no protocol work. Rejected because the CLI's default action is the interactive multiplexer, the mutating commands would run outside the harness's own ownership, and process startup per read is slower than one socket call.

## Consequences

Herdr state survives no harness restart and needs none: it is re-read from the server, and a Client reload re-subscribes. Nothing about herdr enters the session log, so no persistence version, SDK expected output, or session projection changes. The panel therefore cannot show herdr history, and a replay fixture cannot reproduce a pane's text.

The service owns a connection the harness did not create, so its lifecycle is explicit: the subscription carries the caller's `AbortSignal`, disposal closes the socket and awaits the close, and a missing server is a reported state rather than a load failure. Only the socket protocol is used, so the harness depends on herdr's wire format rather than its CLI, and the expected protocol number is a configuration field that fails loud as `incompatible` instead of parsing unknown frames.

The GUI's commands are the read/prompt/send-keys/focus subset; pane and workspace creation stay with the herdr server until the harness owns that lifecycle. A later model-facing tool package reuses this service, and anything the model sees is then a session event on top of it.
