---
description: "Follow and steer every DSH Session from a private Telegram forum group: one topic per root Session with a live status card for its teammates and subagents, notifications, prompts, stop, and approval buttons."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-telegram-bridge

English | [中文](README.zh.md)

## Summary

`dsh-experimental-telegram-bridge` lets you follow and steer DSH from your phone through Telegram. Every root Session of every mode gets a topic in a private forum group once it runs a turn. A pinned, self-updating status card shows the Lead, teammates, subagents, models, states, and token use; finished turns, failures, and questions arrive as notifications. `/yeni` starts a Session in a chosen project and mode, topic text becomes a prompt, `/dur` stops the turn, and approvals arrive with buttons that race the Web dialog. The bridge polls Telegram, needs no inbound port, and accepts input only from configured users.

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

### Prepare Telegram

1. Create a bot with @BotFather and keep its token.
2. Create a private group and enable Topics.
3. Add the bot as an administrator with the Manage topics and Pin messages rights.
4. Note the group's chat id and your own user id, for example from the bot's `getUpdates` after you post in the group.

### Configuration

Mount the plugin in a composition that provides `storageDomain`:

```yaml
- id: telegram-bridge
  name: '@deepseek-ai/dsh-experimental-telegram-bridge'
  config:
    chatId: -1001234567890
    allowedUserIds: [123456789]
    webUrl: https://host.example/
```

| Field | Default | Meaning |
|---|---|---|
| `botToken` | `$TELEGRAM_BOT_TOKEN` | Bot token; loading fails when neither is set |
| `chatId` | required | Forum group that holds one topic per root Session |
| `allowedUserIds` | required | Telegram users whose commands the bridge answers; must not be empty |
| `apiBaseUrl` | `https://api.telegram.org` | Bot API base URL |
| `webUrl` | unset | Web UI URL linked from each status card |
| `sendIntervalMs` | `3000` | Minimum gap between two Telegram writes; groups allow about 20 messages per minute |
| `cardIntervalMs` | `5000` | Gap between status-card refreshes |
| `excerptChars` | `300` | Maximum characters of agent text quoted in a notification |
| `pollTimeoutSeconds` | `30` | Telegram long-poll timeout |
| `projectsDir` | unset | Absolute directory where `/yeni` creates new git projects; unset offers only registered projects |
| `draftTtlMinutes` | `10` | Minutes an unfinished `/yeni` stays answerable |

### What arrives in Telegram

| Event | Message |
|---|---|
| A root Session runs its first turn | New topic `[Mode] title · project` with a pinned status card |
| A root turn finishes | `✅ Tur bitti.` with an excerpt of the last answer, with sound |
| A root turn is stopped | `⏹ Tur durduruldu.`, silent |
| Any turn in the tree fails | `❌` with the failure message, with sound |
| A teammate cannot start | `❌ <name> başlatılamadı` with the reason, with sound |
| An approval is requested anywhere in the tree | `🔔` with the tool, the reason, and `✅ Onayla` / `❌ Reddet` buttons; the message records the answer and who gave it |
| An agent calls `ask_user_question` | `❓` with the first question, with sound |
| Any other change | Status card edit only |

Input from allowed users:

| Input | Effect |
|---|---|
| `/yeni <task>` or `/new <task>` | Asks for a project, then a mode, with buttons; then creates the Session and queues the task as its first prompt |
| `➕ Yeni proje` button, then a name | Creates `<projectsDir>/<name>`, runs `git init` when it has no `.git`, and registers it as a project |
| `/oturumlar` or `/sessions` | Lists followed Sessions |
| `/durum` or `/status` in a topic | Repeats the topic's status card |
| `/dur` or `/stop` in a topic | Cancels the root Session's running turn |
| Plain text in a topic | Queued as a prompt to the root Session, replied with `📨 İletildi.` |
| An approval button | Answers that approval if it is still pending |

Prompts, `/dur`, and `/yeni` need the `sessionController` service, `/yeni` also reads `workspaceRegistry` and `agentPresets`; without them the bridge replies with the failure. The mode is chosen for each new Session, so a project is never tied to Team mode.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/tracker.ts`](src/tracker.ts) folds every `session/event` into one tree per root Session, using each Session header's `parentSession`, `team/member` rows, and `subagent/descriptor` labels; it renders the card and returns notifications without I/O. [`src/telegram.ts`](src/telegram.ts) calls the Bot API, serializes writes with a minimum gap, and waits out `retry_after`. [`src/index.ts`](src/index.ts) opens the `telegram_bridge` storage domain ([`src/storage.ts`](src/storage.ts)), which keeps each root Session's topic and card message and the next update offset; creates a topic the first time a root Session needs one; refreshes changed cards on a timer; and long-polls for messages and button presses, ignoring other chats and users. It answers `approval/request` first: it sends the buttons and calls `next()` for the Web answerer at the same time, and the first of a button press, a Web outcome other than `unavailable`, or the request's abort signal decides. When the buttons could not be sent and the Web is unavailable, the outcome is `unavailable`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, topics, card refresh, notifications, commands, prompts, approvals |
| [`src/launcher.ts`](src/launcher.ts) | `/yeni` drafts, project creation, Session start |
| [`src/tracker.ts`](src/tracker.ts) | Session tree, card text, notifications |
| [`src/telegram.ts`](src/telegram.ts) | Bot API client and write queue |
| [`src/storage.ts`](src/storage.ts) | Durable topic and update-offset records |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session events](../../core/session/README.md) — the events the tracker folds.
- [Agent Teams](../agent-team/README.md) — the roster behind teammate rows.
- [Storage domains](../../storage/storage-domain/README.md) — the durable topic records.

-----

<a id="model-experience"></a>
## Model Experience

None, as the bridge registers no tools, prompts, or Session events; text it forwards enters a Session as an ordinary user prompt.

#### KV Cache effect

No direct effect; the bridge never writes model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web dialog stays open** — after an approval is answered in Telegram, an open Web approval dialog stays visible and its later answer is ignored, because `approval/request` gives answerers no signal for a decision made upstream.
- **Drafts are in memory** — an unfinished `/yeni` is lost when DSH restarts.
- **Questions are not answerable** — `ask_user_question` arrives as a notification; answer it in the Web UI.
- **Not end-to-end encrypted** — Telegram bot traffic is readable by Telegram; titles, project names, and excerpts leave the machine.
- **Starts empty** — Sessions are followed from the first event after the bridge starts; earlier history is not replayed.
- **Forum group required** — a group without Topics rejects topic creation and the bridge logs the failure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
