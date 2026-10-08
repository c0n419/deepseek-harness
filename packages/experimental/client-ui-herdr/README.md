---
description: "Drive the Herdr multiplexer from the Web client: workspace tree, agent status, pane output, and prompts."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-herdr

English | [中文](README.zh.md)

## Summary

This optional browser plugin adds a Herdr entry to the sidebar's panel rail and a matching global page. The page renders the Herdr server's workspaces, tabs, panes, and detected agents as a tree with status badges, shows the selected pane in an interactive terminal screen with its colors, and offers a prompt box, a key row, and a focus action. A header line reports the connection: the server version while connected, or the unavailable and incompatible states with a retry. Choose it through the published experimental Herdr bundle.

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

Enable this package through [`@deepseek-ai/dsh-experimental-herdr-bundle`](../herdr-bundle/README.md), which supplies the host socket service and this panel together. The Web Client loader mounts the `/client` export; the root Host export is inert.

### Inspect the tree

The left column lists every workspace the Herdr server reports, with its tabs, and the panes each tab holds. A pane row names the pane and the agent Herdr detected in it. A pane that hosts an agent also carries a state dot and a matching badge — idle is neutral, working is ongoing, blocked is warning, done is success — while a pane with no agent carries neither and prints the no-agent copy instead, because Herdr's `unknown` status for such a pane describes no agent at all. The selected pane is marked in the list, and the right column follows it. Herdr's own focus is shown on the selected row, and the Focus action moves the server's focus to the selected pane, agent or not.

### Read output and send input

The right column shows the selected pane in an xterm screen: its recent output with colors, wrapped at the pane's own column count, with the panel's height filled by rows. Clicking the screen and typing sends every keystroke — letters, Enter, arrows, Ctrl combinations — to the pane as raw terminal input, in order, batching keys typed while a send is in flight; a new read replaces the screen only while the human is at the bottom of its history, so scrolling up to read older output is not interrupted. No controls appear until a pane is selected. Herdr pushes no event when a plain shell prints, so the panel re-reads the selected pane every `outputRefreshMs` milliseconds (a Host setting carried in the view), skipping a tick while a read is in flight; a pushed revision change, re-picking the pane, and every sent prompt, key, or typed input also re-read it, and a read that lands after the human moved on is discarded. The prompt box submits on Enter or Send and sends one prompt to the agent hosted by the selected pane and is withheld on a pane that has none — the box shows the no-agent copy and Send stays disabled — because Herdr can only prompt an agent. The key row and the Focus action address the pane itself, so they stay available for every pane; the keys are Esc, Ctrl+C, Enter, Up, Down, y, and n. A command Herdr rejects is reported beside the controls, and a pane that disappeared from the server is reported in place of its output.

### Connection states

Both non-connected states offer Retry, because both recover the same way: the panel drops the settled watch and opens a fresh one, and the Host answers that with a new probe of the server. When no server answers on the configured socket, the page reports that Herdr is not running and names the reason. When a server answers with a different protocol number than this panel speaks, the page reports the expected and reported numbers instead of showing a tree it cannot trust; after the Herdr server is upgraded or replaced, Retry picks it up without reloading the page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The Client export mounts its own generated `/remote` contribution, registers its locale dictionaries, and registers two slots through Cordis effects: a `sidebar.panellist` rail icon whose id is also the keyed `main` panel. One stream handle feeds a shared `createSnapshotStore` holding the whole `HerdrView`; the panel subscribes through the injected hook seat, so the tree and the connection line re-render from one snapshot. Every command is a unary Remote call addressed by the selected pane's id — Herdr's agent-named methods are never used, so a pane hosting no agent is still focusable and keyable — and a pane read is issued when the selected pane's pushed revision changes, when the pane is picked again, or after a rejected command — never on a timer. Disposing the plugin fiber aborts the stream, withdraws both slots, and unmounts the Remote namespace.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Remote mount, dictionaries, rail icon, and main panel registration |
| [`src/client/HerdrPanel.tsx`](src/client/HerdrPanel.tsx) | Connection states, tree, output, prompt, and key controls |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Herdr bundle](../herdr-bundle/README.md) — the published opt-in bundle that mounts the host service and this panel.
- [Herdr host service](../herdr/README.md) — socket protocol, Remote methods, and configuration.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser panel registers no model-facing input; the prompt it sends goes to the Herdr agent through the Herdr server.

#### KV Cache effect

No direct effect; no model request of this harness carries Herdr state.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No layout mutation** — the panel cannot create, close, split, or move workspaces, tabs, or panes; it reads structure and drives the selected pane.
- **Reconstructed screen** — the screen is rebuilt from Herdr's recent rows on each read, not streamed, so the cursor rests at the end of the last row and a full-screen program's cursor position is not reproduced.
- **Interval reads** — the shown pane follows its output by re-reading every `outputRefreshMs`, so new text and typed echoes appear up to one interval late.
- **Fixed width** — the screen keeps the pane's column count; a pane wider than the panel scrolls horizontally instead of re-wrapping.
- **Prompting needs an agent** — the prompt box is withheld on a pane where Herdr detected no agent; such a pane still accepts the key row and the Focus action.
- **Late plugin activation** — after enabling the bundle in an already-open page, reload to receive the panel's slots.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
