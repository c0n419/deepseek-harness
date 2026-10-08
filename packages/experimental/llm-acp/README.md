---
description: "Run each DSH Session's turns in its own external coding agent — Claude Code, Codex, OpenCode, omp, Gemini CLI, or pi — over the Agent Client Protocol, optionally in a dedicated git worktree."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-llm-acp

English | [中文](README.zh.md)

## Summary

`dsh-experimental-llm-acp` registers an LLM provider route, `acp` by default, whose models are external coding agents. A Session that uses model `claude` or `codex/gpt-5` gets its own agent process and ACP session; every turn sends the Session's new user input to that agent and streams its answer back as the assistant message, so the agent keeps its own context between turns. With worktree isolation each Session works in its own git worktree and branch. Team mode uses it to run external developers; see [`dsh-experimental-team-mode-profile`](../team-mode-profile/README.md).

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

Mount the plugin with at least one harness and a permission policy:

```yaml
- id: llm-acp
  name: '@deepseek-ai/dsh-experimental-llm-acp'
  config:
    permission: allow
    harnesses:
      claude:
        command: npx
        args: ['-y', '@agentclientprotocol/claude-agent-acp@0.87.0']
      opencode:
        command: opencode
        args: [acp]
```

A Session then selects provider `acp` and model `<harness>` or `<harness>/<model>`. The harness must be installed and signed in on the Host. The route never retries a failed turn, because resending a prompt would repeat the agent's edits and commands.

<a id="configuration"></a>
### Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` | `acp` | Provider route registered on the LLM service |
| `harnesses` | `{}` | Harness name → `command`, `args`, `env`, and optional `authMethod`; the name may not contain `/` |
| `permission` | required | `allow` approves each permission prompt with its first allow option; `reject` cancels it |
| `isolation` | `worktree` | `worktree` gives each Session its own git worktree; `shared` runs in the Session's working directory |
| `worktreeRoot` | `~/.dsh/worktrees` | Absolute directory that holds `<session id>` worktrees |
| `branchPrefix` | `dsh-team/` | Prefix of each worktree's new branch |
| `disposeEofGraceMs` | `6000` | Time an agent has to exit after its stdin closes |
| `disposeGraceMs` | `3000` | Time between SIGTERM and SIGKILL |

`authMethod` names an ACP auth method that the client calls before opening the session, for adapters that require it. `env` is added to the Host environment after credentials are scrubbed, so put a harness's own API key there when it should not come from its login.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) validates the configuration, registers the adapter, and releases a Session's agent when that Agent is disposed. On a Session's first request it reads the Session's working directory, creates `<worktreeRoot>/<session id>` on branch `<branchPrefix><session id>` when isolation is `worktree` — checking out that branch again when an earlier worktree was removed, and failing with `WORKTREE_FAILED` and git's error text otherwise — and starts the agent. The prompt for a turn is the user text after the last assistant message; when the agent is new but the Session has earlier turns, for example after a Host restart, the prompt starts with a transcript of those turns.

[`src/developer.ts`](src/developer.ts) owns one agent: it spawns the process through the subprocess service, initializes ACP, optionally authenticates, opens a session, and selects the requested value of the session's `model` config option. Agent text becomes text blocks; thoughts and tool-call titles become reasoning blocks. Aborting a request sends `session/cancel`. Teardown reuses `disposeAcpChild` from [`dsh-subagent-acp`](../../subagent/subagent-acp/README.md).

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration, adapter, worktrees, and Session lifecycle |
| [`src/developer.ts`](src/developer.ts) | One agent process, its ACP session, and turn streaming |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Team mode](../team-mode-profile/README.md) — the preset that uses this route for external developers.
- [ACP subagent backend](../../subagent/subagent-acp/README.md) — one-shot ACP children for `subagent`.
- [LLM service](../../llm/llm/README.md) — adapters, routes, and retry policy.

-----

<a id="model-experience"></a>
## Model Experience

### External agent turns

#### What the model sees

The external agent receives only text in one `session/prompt` per turn: the Session's new user messages, joined by blank lines, plus a transcript that starts with `Earlier conversation in this task, restored after a restart:` when its process was restarted. DSH system prompts and tool schemas are not sent; the agent uses its own prompt and tools.

#### Token effect

The DSH Session records the agent's answer as an assistant message and its thoughts and tool-call titles as reasoning. Token usage is not reported.

#### KV Cache effect

Each agent manages its own context and cache. A restart transcript re-sends earlier turns once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text only** — images and files in user messages are not sent to the agent.
- **No durable remote session** — a Host restart starts a new agent session that receives a text transcript instead of using ACP `session/load`.
- **No token accounting** — the route reports no usage, so budgets and meters do not count external work.
- **Unattended permissions** — prompts are answered by the fixed policy; a person is never asked.
- **No confinement** — the agent runs as the Host user with that user's files, network, and credentials; a worktree is only its working directory, not a sandbox, and the DSH file sandbox and tool scope do not apply to it.
- **Worktrees are kept** — DSH never removes worktrees or branches; delete them with `git worktree remove` after merging.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
