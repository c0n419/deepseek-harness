---
description: "通过 Agent Client Protocol，让每个 DSH 会话的轮次在其专属的外部编码智能体——Claude Code、Codex、OpenCode、omp、Gemini CLI 或 pi——中运行，并可使用独立的 git worktree。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-llm-acp

[English](README.md) | 中文

## 概述

`dsh-experimental-llm-acp` 注册一个 LLM 提供方路由（默认为 `acp`），其模型就是外部编码智能体。使用模型 `claude` 或 `codex/gpt-5` 的会话会获得自己的智能体进程和 ACP 会话；每个轮次都把会话中新的用户输入发送给该智能体，并把它的回答流式返回为助手消息，因此智能体在轮次之间保留自己的上下文。启用 worktree 隔离时，每个会话都在自己的 git worktree 和分支中工作。团队模式用它来运行外部开发者；参见 [`dsh-experimental-team-mode-profile`](../team-mode-profile/README.zh.md)。

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

挂载该插件时至少配置一个 harness 和一个权限策略：

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

之后会话选择提供方 `acp` 和模型 `<harness>` 或 `<harness>/<model>`。该 harness 必须已在 Host 上安装并登录。此路由从不重试失败的轮次，因为重新发送提示会让智能体重复执行编辑和命令。

<a id="configuration"></a>
### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `acp` | 在 LLM 服务上注册的提供方路由 |
| `harnesses` | `{}` | harness 名称 → `command`、`args`、`env` 以及可选的 `authMethod`；名称不能包含 `/` |
| `permission` | 必填 | `allow` 用第一个允许选项批准每个权限请求；`reject` 取消请求 |
| `isolation` | `worktree` | `worktree` 为每个会话提供自己的 git worktree；`shared` 在会话的工作目录中运行 |
| `worktreeRoot` | `~/.dsh/worktrees` | 存放 `<session id>` worktree 的绝对目录 |
| `branchPrefix` | `dsh-team/` | 每个 worktree 新分支的前缀 |
| `disposeEofGraceMs` | `6000` | 关闭 stdin 后留给智能体退出的时间 |
| `disposeGraceMs` | `3000` | SIGTERM 与 SIGKILL 之间的时间 |

`authMethod` 指定一个 ACP 认证方法，客户端会在打开会话前调用它，用于需要这一步的适配器。`env` 会在清除凭据之后加入 Host 环境，因此当某个 harness 的 API key 不应来自其登录状态时，请把它放在这里。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`src/index.ts`](src/index.ts) 校验配置、注册适配器，并在会话的 Agent 被释放时释放其智能体。会话的第一个请求会读取会话的工作目录；当隔离方式为 `worktree` 时，在分支 `<branchPrefix><session id>` 上创建 `<worktreeRoot>/<session id>`——如果之前的 worktree 已被删除，则重新检出该分支；否则以 `WORKTREE_FAILED` 和 git 的错误文本失败——然后启动智能体。一个轮次的提示是最后一条助手消息之后的用户文本；如果智能体是新启动的而会话已有早先的轮次（例如 Host 重启之后），提示会以这些轮次的对话记录开头。

[`src/developer.ts`](src/developer.ts) 管理一个智能体：它通过 subprocess 服务启动进程，初始化 ACP，按需进行认证，打开会话，并选择会话 `model` 配置选项中被请求的值。智能体的文本成为文本块；思考内容和工具调用标题成为推理块。中止请求时会发送 `session/cancel`。拆除时复用 [`dsh-subagent-acp`](../../subagent/subagent-acp/README.zh.md) 中的 `disposeAcpChild`。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、适配器、worktree 和会话生命周期 |
| [`src/developer.ts`](src/developer.ts) | 单个智能体进程、它的 ACP 会话以及轮次流式输出 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [团队模式](../team-mode-profile/README.zh.md)——使用此路由运行外部开发者的预设。
- [ACP 子智能体后端](../../subagent/subagent-acp/README.zh.md)——供 `subagent` 使用的一次性 ACP 子智能体。
- [LLM 服务](../../llm/llm/README.zh.md)——适配器、路由和重试策略。

-----

<a id="model-experience"></a>
## 模型体验

### 外部智能体轮次

#### 模型看到的内容

外部智能体每个轮次通过一次 `session/prompt` 只接收文本：会话新的用户消息（以空行连接）；在其进程重启后，还会收到以 `Earlier conversation in this task, restored after a restart:` 开头的早先轮次对话记录。DSH 的系统提示和工具 schema 不会发送；智能体使用自己的提示和工具。

#### Token 影响

DSH 会话把智能体的回答记录为助手消息，把它的思考内容和工具调用标题记录为推理内容。不报告 token 用量。

#### KV Cache 影响

每个智能体管理自己的上下文和缓存。重启时的对话记录会把早先的轮次重新发送一次。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限文本**——用户消息中的图片和文件不会发送给智能体。
- **没有持久的远程会话**——Host 重启后会启动新的智能体会话，它收到文本对话记录，而不是使用 ACP `session/load`。
- **没有 token 统计**——该路由不报告用量，因此预算和计量不计入外部工作。
- **无人值守的权限处理**——权限请求按固定策略应答，从不询问用户。
- **没有隔离限制**——智能体以 Host 用户身份运行，可访问该用户的文件、网络和凭据；worktree 只是它的工作目录，而不是沙箱，DSH 文件沙箱和工具范围对它不起作用。
- **worktree 会保留**——DSH 从不删除 worktree 或分支；合并后请用 `git worktree remove` 删除它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
