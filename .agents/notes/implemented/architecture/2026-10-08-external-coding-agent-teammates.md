# Agent Note: External coding agents as Agent Teams teammates

Status: implemented

English | [中文](2026-10-08-external-coding-agent-teammates.zh.md)

## Problem

Team mode lets a Lead run a software team whose developers are external coding agents — Claude Code, Codex, OpenCode, omp, Gemini CLI, pi — each with its own context and model. Agent Teams already owns the roster, durable mailbox, task board, wait/interrupt, and Web panel, but every teammate is an in-process continuable child Session driven by the DSH loop. The continuation manager creates an in-process Agent for each child, so a remote process cannot be a roster member on its own, and the existing ACP subagent backend is one-shot: it opens a session, sends one prompt, and exits.

## Decision

An external developer is an ordinary continuable child Session whose model route is an external agent. [`dsh-experimental-llm-acp`](../../../../packages/experimental/llm-acp/README.md) registers the `acp` LLM route: model `<harness>[/<model>]` binds the Session to one long-lived ACP agent process, each request sends the user input after the last assistant message, and the streamed answer becomes the assistant message. Roster, mailbox delivery, resume, task board, and the Web panel therefore work without a second member kind, and everything the Lead sees is in the child's Session log. The route never retries, because a resent prompt repeats the agent's side effects.

`spawn_teammate({ harness })` creates the child with `agentOptions` on that route and an empty tool scope. Tool-agent-team installs no Team tools for a teammate whose scope hides `send_message`, and the Team service forwards the text of each of that teammate's finished turns to the Lead as a Team message. The rule is stated on tool scope, not on the route, so it holds for any teammate that cannot message the Lead. `TeamMemberSnapshot.model` records the requested route so `list_agents` shows it while the child is not loaded.

Each external Session runs in its own git worktree on branch `dsh-team/<session id>`; the Lead reviews and merges. The model is chosen through the agent's ACP `model` session config option, which Claude Code, OpenCode, and omp expose, instead of per-harness command-line flags.

Team mode ships as the opt-in [`dsh-experimental-team-mode-profile`](../../../../packages/experimental/team-mode-profile/README.md) bundle that inserts a `team` preset, because release packages such as `dsh-web-app` may not depend on experimental packages.

## Alternatives considered

- **Bridge to herdr** — rejected by the product owner: herdr is a reference for the capability, not an integration target.
- **PTY-driven interactive TUIs with screen-scraped status** — fragile, and the terminal backend does not support full-screen programs.
- **A separate `external` roster member kind** — duplicates mailbox delivery, resume, and the Web projection for a second identity type.
- **Per-harness headless CLIs (`claude -p --resume`, `codex exec resume`, `pi --mode rpc`)** — one driver per harness instead of one ACP driver.

## Consequences

One driver serves every ACP-capable harness, and external developers appear in the existing roster, panel, and Session logs. The cost: external turns report no token usage; text only reaches the agent; a Host restart replays a text transcript instead of loading the remote session; permissions are answered by a fixed policy; and the `team` preset copies the Standard plugin list.
