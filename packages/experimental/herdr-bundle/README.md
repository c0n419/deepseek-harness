---
description: "Enable experimental Herdr multiplexer control: the host socket service and the Web pane panel."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-herdr-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle composes the Herdr host socket service and its Web panel. Shipped profiles leave it disabled.

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

Open Plugins in the Web sidebar and enable Herdr, marked by a terminal-window icon. The Herdr entry then appears in the sidebar's panel rail; open it to inspect workspaces, tabs, and panes, read the selected pane's output, send a prompt or a permitted key, and focus a pane. Start the Herdr server before enabling the bundle: with no server on the configured socket the panel reports that Herdr is not running and offers a retry. Disabling the bundle withdraws both rows; the panel and the socket service stop together.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` inserts two rows: the host service (`@deepseek-ai/dsh-experimental-herdr`) and the Web panel (`@deepseek-ai/dsh-experimental-client-ui-herdr`). Optional-bundle installation makes the package available to management without selecting it in default profiles. The browser contribution owns its generated Remote mount; stable API Remotes do not import experimental code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Herdr host service](../herdr/README.md) — socket protocol, Remote surface, and configuration.
- [Herdr Web panel](../client-ui-herdr/README.md) — the panel's surfaces and controls.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as the panel drives the Herdr server from the browser and registers no model-facing input.

#### KV Cache effect

No direct effect; no model request carries Herdr state.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One server per process** — the service speaks to the single socket named in its configuration; named Herdr sessions on other sockets are not composed.
- **No layout mutation** — create, close, split, move, and server commands are out of scope; the panel reads structure and drives the focused pane only.
- **No persisted panel state** — a page reload re-opens the view stream; nothing about Herdr is written to a Session log.
- **Requires a reachable Herdr version** — the service checks the reported protocol and reports an incompatible state instead of degrading.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
