---
description: "在私有 Telegram 论坛群组中跟踪并操控每个 DSH 会话：每个根会话一个话题，带有显示队友和子智能体的实时状态卡片、通知、提示、停止和审批按钮。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-telegram-bridge

[English](README.md) | 中文

## 概述

`dsh-experimental-telegram-bridge` 让你通过 Telegram 在手机上跟踪并操控 DSH。任何模式下的每个根会话在运行第一个轮次后，都会在私有论坛群组中获得一个话题。置顶且自动更新的状态卡片显示 Lead、它的队友和子智能体、它们的模型和状态以及 token 用量。轮次完成、失败和提问会以通知形式到达。`/yeni` 在所选项目和模式中启动会话，话题中的文本会成为提示，`/dur` 会停止轮次，审批请求带有与 Web 对话框竞争作答的按钮。桥接通过轮询 Telegram 工作，不需要入站端口，并且只接受已配置群组中已配置用户的输入。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 准备 Telegram

1. 通过 @BotFather 创建机器人并保存其 token。
2. 创建一个私有群组并启用话题（Topics）。
3. 把机器人添加为管理员，并授予“管理话题”和“置顶消息”权限。
4. 记下群组的 chat id 和你自己的用户 id，例如在群组中发言后从机器人的 `getUpdates` 中获取。

### 配置

在提供 `storageDomain` 的组合中挂载此插件：

```yaml
- id: telegram-bridge
  name: '@deepseek-ai/dsh-experimental-telegram-bridge'
  config:
    chatId: -1001234567890
    allowedUserIds: [123456789]
    webUrl: https://host.example/
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `botToken` | `$TELEGRAM_BOT_TOKEN` | 机器人 token；两者都未设置时加载失败 |
| `chatId` | 必填 | 为每个根会话保存一个话题的论坛群组 |
| `allowedUserIds` | 必填 | 桥接会回应其命令的 Telegram 用户；不能为空 |
| `apiBaseUrl` | `https://api.telegram.org` | Bot API 基址 |
| `webUrl` | 未设置 | 每张状态卡片链接到的 Web 界面地址 |
| `sendIntervalMs` | `3000` | 两次 Telegram 写入之间的最小间隔；群组每分钟大约允许 20 条消息 |
| `cardIntervalMs` | `5000` | 状态卡片刷新的间隔 |
| `excerptChars` | `300` | 通知中引用的智能体文本的最大字符数 |
| `pollTimeoutSeconds` | `30` | Telegram 长轮询超时 |
| `projectsDir` | 未设置 | `/yeni` 创建新 git 项目的绝对目录；未设置时只提供已注册的项目 |
| `draftTtlMinutes` | `10` | 未完成的 `/yeni` 保持可作答的分钟数 |

### Telegram 中会收到什么

| 事件 | 消息 |
|---|---|
| 根会话运行第一个轮次 | 新话题 `[Mode] title · project`，带置顶的状态卡片 |
| 根轮次完成 | `✅ Tur bitti.` 并附上最后回答的摘录，有提示音 |
| 根轮次被停止 | `⏹ Tur durduruldu.`，静音 |
| 树中任一轮次失败 | `❌` 和失败信息，有提示音 |
| 队友无法启动 | `❌ <name> başlatılamadı` 和原因，有提示音 |
| 树中任意位置请求审批 | `🔔` 和工具、原因以及 `✅ Onayla` / `❌ Reddet` 按钮；消息会记录答案及作答方 |
| 智能体调用 `ask_user_question` | `❓` 和第一个问题，有提示音 |
| 其他变化 | 仅编辑状态卡片 |

桥接在启动时把 `/yeni`、`/oturumlar`、`/durum` 和 `/dur` 发布为群组的命令菜单，因此输入 `/` 时会出现这些建议。

允许用户的输入：

| 输入 | 效果 |
|---|---|
| `/yeni <task>` 或 `/new <task>` | 先用按钮询问项目，再询问模式；然后创建会话并把任务作为第一个提示排入 |
| `➕ Yeni proje` 按钮，然后输入名称 | 创建 `<projectsDir>/<name>`，没有 `.git` 时运行 `git init`，并将其注册为项目 |
| `/oturumlar` 或 `/sessions` | 列出跟踪中的会话 |
| 话题中的 `/durum` 或 `/status` | 重新发送该话题的状态卡片 |
| 话题中的 `/dur` 或 `/stop` | 取消根会话正在运行的轮次 |
| 话题中的纯文本 | 作为提示排入根会话，并回复 `📨 İletildi.` |
| 审批按钮 | 若该审批仍在等待，则作答 |

提示、`/dur` 和 `/yeni` 需要 `sessionController` 服务，`/yeni` 还读取 `workspaceRegistry` 和 `agentPresets`；缺少时桥接会回复失败信息。模式为每个新会话单独选择，因此项目不会绑定到 Team 模式。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`src/tracker.ts`](src/tracker.ts) 使用每个会话头中的 `parentSession`、`team/member` 记录和 `subagent/descriptor` 标签，把每个 `session/event` 折叠为每个根会话一棵树；它渲染卡片并返回通知，不做任何 I/O。[`src/telegram.ts`](src/telegram.ts) 调用 Bot API，以最小间隔串行化写入，并等待 `retry_after`。[`src/index.ts`](src/index.ts) 打开 `telegram_bridge` 存储域（[`src/storage.ts`](src/storage.ts)），其中保存每个根会话的话题和卡片消息以及下一个更新偏移；在根会话第一次需要时创建话题；按定时器刷新变化的卡片；并长轮询消息和按钮点击，忽略其他聊天和用户。它最先应答 `approval/request`：发送按钮的同时调用 `next()` 交给 Web 应答者，按钮点击、非 `unavailable` 的 Web 结果或请求的中止信号中最先到达者决定结果。按钮未能发送且 Web 不可用时，结果为 `unavailable`。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、话题、卡片刷新、通知、命令、提示、审批 |
| [`src/launcher.ts`](src/launcher.ts) | `/yeni` 草稿、项目创建、会话启动 |
| [`src/tracker.ts`](src/tracker.ts) | 会话树、卡片文本、通知 |
| [`src/telegram.ts`](src/telegram.ts) | Bot API 客户端和写入队列 |
| [`src/storage.ts`](src/storage.ts) | 持久的话题和更新偏移记录 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话事件](../../core/session/README.zh.md)——跟踪器折叠的事件。
- [Agent Teams](../agent-team/README.zh.md)——队友行背后的名册。
- [存储域](../../storage/storage-domain/README.zh.md)——持久的话题记录。

-----

<a id="model-experience"></a>
## 模型体验

无，因为桥接不注册任何工具、提示或会话事件；它转发的文本作为普通用户提示进入会话。

#### KV Cache 影响

没有直接影响；桥接从不写入模型输入。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **Web 对话框保持打开**——审批在 Telegram 中作答后，已打开的 Web 审批对话框仍然可见，其后的回答会被忽略，因为 `approval/request` 不向应答者提供上游已决定的信号。
- **草稿仅在内存中**——DSH 重启时未完成的 `/yeni` 会丢失。
- **无法回答提问**——`ask_user_question` 只以通知形式到达；请在 Web 界面中回答。
- **非端到端加密**——Telegram 能读取机器人通信；标题、项目名称和摘录会离开本机。
- **从空开始**——桥接启动后才从第一个事件开始跟踪会话；不会回放更早的历史。
- **需要论坛群组**——未启用话题的群组会拒绝创建话题，桥接会记录该失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
