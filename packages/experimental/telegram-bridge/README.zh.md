---
description: "在私有 Telegram 论坛群组中跟踪每个 DSH 会话：每个根会话一个话题，带有显示队友和子智能体的实时状态卡片，并在轮次完成、失败、审批请求和提问时发送通知。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-telegram-bridge

[English](README.md) | 中文

## 概述

`dsh-experimental-telegram-bridge` 让你通过 Telegram 在手机上跟踪 DSH。任何模式下的每个根会话在运行第一个轮次后，都会在私有论坛群组中获得一个话题。话题中置顶的状态卡片显示 Lead、它的队友和子智能体、它们的模型和状态以及 token 用量，并随工作进展自行更新。轮次完成、失败、审批请求和智能体提问会以通知形式到达。桥接通过轮询 Telegram 工作，因此不需要入站端口，并且只回应已配置群组中的已配置用户。本版本不包含从 Telegram 发送提示和回答审批。

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

### Telegram 中会收到什么

| 事件 | 消息 |
|---|---|
| 根会话运行第一个轮次 | 新话题 `[Mode] title · project`，带置顶的状态卡片 |
| 根轮次完成 | `✅ Tur bitti.` 并附上最后回答的摘录，有提示音 |
| 根轮次被停止 | `⏹ Tur durduruldu.`，静音 |
| 树中任一轮次失败 | `❌` 和失败信息，有提示音 |
| 队友无法启动 | `❌ <name> başlatılamadı` 和原因，有提示音 |
| 请求审批 | `🔔` 和工具及原因，有提示音 |
| 智能体调用 `ask_user_question` | `❓` 和第一个问题，有提示音 |
| 其他变化 | 仅编辑状态卡片 |

允许用户可用的命令：`/oturumlar`（或 `/sessions`）列出跟踪中的会话；在话题中使用 `/durum`（或 `/status`）会重新发送该话题的状态卡片。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`src/tracker.ts`](src/tracker.ts) 使用每个会话头中的 `parentSession`、`team/member` 记录和 `subagent/descriptor` 标签，把每个 `session/event` 折叠为每个根会话一棵树；它渲染卡片并返回通知，不做任何 I/O。[`src/telegram.ts`](src/telegram.ts) 调用 Bot API，以最小间隔串行化写入，并等待 `retry_after`。[`src/index.ts`](src/index.ts) 打开 `telegram_bridge` 存储域（[`src/storage.ts`](src/storage.ts)），其中保存每个根会话的话题和卡片消息以及下一个更新偏移；在根会话第一次需要时创建话题；按定时器刷新变化的卡片；并长轮询命令，忽略其他聊天和用户。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、话题、卡片刷新、通知、命令 |
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

无，因为桥接只读取会话事件，不注册任何工具、提示或会话事件。

#### KV Cache 影响

没有直接影响；桥接从不写入模型输入。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅跟踪**——从 Telegram 发送提示、`/stop`、审批按钮和回答问题将在后续版本中提供。
- **非端到端加密**——Telegram 能读取机器人通信；标题、项目名称和摘录会离开本机。
- **从空开始**——桥接启动后才从第一个事件开始跟踪会话；不会回放更早的历史。
- **需要论坛群组**——未启用话题的群组会拒绝创建话题，桥接会记录该失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
