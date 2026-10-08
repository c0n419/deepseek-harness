---
description: "Add Team mode to the Web mode picker: a Lead agent that gives tasks to external coding agents such as Claude Code, Codex, and OpenCode, each with its own context, model, and git branch."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-team-mode-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-team-mode-profile` adds **Team mode** to the Web and Desktop mode picker. In Team mode the session's agent is a Lead that runs a software team: it creates developers, gives them tasks, reads their reports, and merges their work. A developer can be a DSH teammate or an external coding agent — Claude Code, Codex, OpenCode, omp, Gemini CLI, or pi — running as its own process with its own context, model, git worktree, and branch. The bundle ships switched off; enable it on the Plugins page, then pick Team mode for a new session.

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

### Enable Team mode

Enable **Team mode** on the Web or Desktop Plugins page, or add the bundle to a CLI Web profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-team-mode-profile
```

Then choose **Team mode** in the mode picker of a new session and describe the work, for example: "Use claude to implement the parser and codex to write its tests, then review both branches and merge them."

### External developers

The Lead creates an external developer with `spawn_teammate({ name, description, prompt, harness })`. `harness` is a configured harness name, optionally followed by `/<model>`, such as `claude/sonnet` or `opencode/anthropic/claude-sonnet-4`. The model must be one the harness offers in its ACP `model` option; an unknown value fails the developer's turn with the available values. Each external developer needs its harness installed and signed in on the Host machine:

| Harness | Command | Sign-in |
|---|---|---|
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp@0.87.0` | Claude Code login or `ANTHROPIC_API_KEY` |
| `codex` | `npx -y @agentclientprotocol/codex-acp@2.1.1` | `codex login` or `OPENAI_API_KEY` |
| `opencode` | `opencode acp` | OpenCode's own provider settings |
| `omp` | `omp acp` | omp's own provider settings |
| `gemini` | `gemini --acp` | Gemini CLI login or `GEMINI_API_KEY` |
| `pi` | `npx -y pi-acp@0.0.34` | pi's own provider settings |

Each developer works in `~/.dsh/worktrees/<session id>` on branch `dsh-team/<session id>`, created from the workspace repository's current `HEAD`. The workspace must be a git repository. The Lead reviews and merges those branches; DSH does not merge or delete them. Change harnesses, permissions, isolation, or the worktree directory by patching the top-level `llm-acp` row; the [`llm-acp` reference](../llm-acp/README.md#configuration) lists every field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). It inserts the `ui-team-mode` Team UI row, the [`dsh-experimental-llm-acp`](../llm-acp/README.md) row that registers the process-wide `acp` route once, and one `@deepseek-ai/dsh-agent-preset` row with id `team`. The preset copies the Standard preset's plugins and replaces its delegation group with a `cordis:group` that isolates the `agentTeams` service and mounts the Team service and the Team tools with `externalProvider: acp`. The route stays outside the preset because several preset revisions can be live at once, and a second registration of `acp` would fail. An external developer is a continuable child Session whose model route is `acp` and whose tool scope is empty: `llm-acp` runs its turns in the external agent, and the Team service forwards each finished turn's reply to the Lead.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Team UI row, the `acp` route row, and the `team` preset row |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`locale/`](locale) | Plugins page title and description |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [External coding agents as an LLM route](../llm-acp/README.md) — process, session, worktree, and model selection.
- [Agent Teams service](../agent-team/README.md) — roster, durable messages, reply forwarding, and the task board.
- [Agent Teams tools](../tool-agent-team/README.md) — `spawn_teammate` and the other Team tools.
- [Agent Teams profile](../agent-team-profile/README.md) — Agent Teams for every mode, without external developers.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

The Lead sees the Standard tool set without `subagent` and `subagent_fork`, plus the Team tools and policy from [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.md), including its external-teammate paragraph and the `harness` parameter of `spawn_teammate`. External developers see only text: their first prompt and later messages from the Lead.

#### Token effect

The bundle adds no prompt text of its own; the Team policy and tool schemas are described by `@deepseek-ai/dsh-experimental-tool-agent-team`.

#### KV Cache effect

The preset's composition is prefix-stable while its patch and the Team tool schemas remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships switched off; no shipped profile enables it.
- **Copied preset** — the `team` preset copies the Standard preset's plugin list; later Standard changes do not reach it until this patch is updated.
- **Mode name is not localized** — the preset sets its own English name and description, so the mode picker shows them in every locale.
- **Not combined with Agent Teams profile** — enabling both bundles mounts the Team UI twice.
- **Host prerequisites** — each harness must be installed and signed in on the Host; `npx` downloads the pinned adapters on first use.
- **External developers are not sandboxed** — with `permission: allow` they approve their own edits and commands and run with the Host user's full access; the worktree separates their branch, not their privileges.
- **Git workspace required** — external developers fail with git's error when the session workspace is not a git repository.
- **agy** — Google Antigravity's `agy` has no ACP mode; add a third-party ACP adapter as a harness only after checking its terms of service.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
