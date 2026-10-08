---
description: "Expose a Herdr server's workspaces, panes, and coding agents through the authenticated Web Remote, with prompt and key control."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-herdr

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-experimental-herdr` connects a running Herdr terminal multiplexer to the harness. It dials the Herdr API socket directly, publishes one Client-facing view of the server's workspaces, tabs, panes, and recognized coding agents, and exposes the `prompt`, `sendKeys`, `focus`, and `read` commands. State is a Remote stream, never session data: a reload re-subscribes and nothing is persisted. It never spawns the `herdr` CLI, so no integration step can start a multiplexer or its server.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose with Typert and mount the generated `/remote` contribution from a Client assembly. `socketPath` names the API socket; omission reads `HERDR_SOCKET_PATH`, then `<XDG_CONFIG_HOME or ~/.config>/herdr/herdr.sock`. `requestTimeoutMs` bounds a round trip and the subscription handshake; `reconnectInitialMs` and `reconnectMaxMs` bound reconnect backoff; `maxFrameBytes` caps one reply or event line; `readLines` sets the lazy read's line budget; `outputCoalesceMs` is the window that turns an event burst into one published frame and one re-read; `outputRefreshMs` travels in every view as the interval a panel re-reads its shown pane at, because Herdr pushes no event when a plain shell prints; `expectedProtocol` is the socket protocol this build speaks.

With no server on the socket the service stays loaded and reports an `unavailable` connection, because Herdr normally starts after the harness and an absent server is not misconfiguration. A server reporting a different protocol reports an `incompatible` connection naming both numbers rather than proceeding; the next watch re-probes, so a server upgrade recovers without a reload.

The `watch` stream yields one complete `HerdrView` per published frame. Every command addresses a pane: `read(paneId)` returns the pane's recent text (the line budget is `readLines`), or `{ notFound: true }` for a pane that closed; `focus(paneId)` and `sendKeys(paneId, keys)` drive that pane through the server's `pane.*` methods, so a shell with no agent is focusable and accepts keys; `prompt(paneId, text)` submits to the agent occupying the pane. `prompt`, `sendKeys`, and `focus` never throw for a missing or blocked target; they return `{ ok: false, code, message }`, and prompting an agent-less pane returns `agent_not_found` as such a result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`resolveSocketPath` resolves the socket explicitly at the package boundary. The service then `ping`s the server for its version and protocol, takes one `session.snapshot` as the bootstrap view, and opens one long-lived `events.subscribe` connection. Every pushed event triggers a snapshot re-read: an event carries one pane's state, and the snapshot also covers topology changes the event payload omits. A dropped stream reconnects with bounded backoff.

The Herdr server answers exactly one request per connection and then closes, so every unary call dials afresh and there is no pool; the subscription connection is the only long-lived socket. Pane text is not pushed at all, so `read` stays a lazy call for the pane a Client displays.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Experimental packages](../README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the service drives the Herdr server on behalf of the browser and registers no model-facing input.

#### KV Cache effect

No direct effect; no model request carries Herdr state.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One server per service instance** — only the socket named in the configuration is composed; other Herdr sessions need their own row.
- **Read-only topology** — create, close, split, move, and every `server.*`, `worktree.*`, and `plugin.*` method are out of scope. The service reads structure and drives a pane that already exists.
- **No persisted state** — the view lives only in the open stream; a reload re-subscribes, and nothing about Herdr enters a Session log.
- **Text is read, never streamed** — the server pushes no pane output, so a Client reads the pane it displays and sees no update until it reads again.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
