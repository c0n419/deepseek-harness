---
description: "Follow every DSH Session from a private Telegram forum group: one topic per root Session with a live status card for its teammates and subagents, plus notifications for finished turns, failures, approvals, and questions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-telegram-bridge

English | [中文](README.zh.md)

## Summary

`dsh-experimental-telegram-bridge` lets you follow DSH from your phone through Telegram. Every root Session of every mode gets a topic in a private forum group once it runs a turn. A pinned status card in that topic shows the Lead, its teammates and subagents, their models and states, and token use, and edits itself as work progresses. Finished turns, failures, approval requests, and agent questions arrive as notifications. The bridge polls Telegram, so it needs no inbound port, and it answers only configured users in the configured group. Sending prompts and answering approvals from Telegram is not part of this version.

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

### What arrives in Telegram

| Event | Message |
|---|---|
| A root Session runs its first turn | New topic `[Mode] title · project` with a pinned status card |
| A root turn finishes | `✅ Tur bitti.` with an excerpt of the last answer, with sound |
| A root turn is stopped | `⏹ Tur durduruldu.`, silent |
| Any turn in the tree fails | `❌` with the failure message, with sound |
| A teammate cannot start | `❌ <name> başlatılamadı` with the reason, with sound |
| An approval is requested | `🔔` with the tool and reason, with sound |
| An agent calls `ask_user_question` | `❓` with the first question, with sound |
| Any other change | Status card edit only |

Commands from allowed users: `/oturumlar` (or `/sessions`) lists followed Sessions; `/durum` (or `/status`) in a topic repeats its status card.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/tracker.ts`](src/tracker.ts) folds every `session/event` into one tree per root Session, using each Session header's `parentSession`, `team/member` rows, and `subagent/descriptor` labels; it renders the card and returns notifications without I/O. [`src/telegram.ts`](src/telegram.ts) calls the Bot API, serializes writes with a minimum gap, and waits out `retry_after`. [`src/index.ts`](src/index.ts) opens the `telegram_bridge` storage domain ([`src/storage.ts`](src/storage.ts)), which keeps each root Session's topic and card message and the next update offset; creates a topic the first time a root Session needs one; refreshes changed cards on a timer; and long-polls for commands, ignoring other chats and users.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, topics, card refresh, notifications, commands |
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

None, as the bridge only reads Session events and registers no tools, prompts, or Session events.

#### KV Cache effect

No direct effect; the bridge never writes model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Follow only** — prompts, `/stop`, approval buttons, and question answers from Telegram come in a later version.
- **Not end-to-end encrypted** — Telegram bot traffic is readable by Telegram; titles, project names, and excerpts leave the machine.
- **Starts empty** — Sessions are followed from the first event after the bridge starts; earlier history is not replayed.
- **Forum group required** — a group without Topics rejects topic creation and the bridge logs the failure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
