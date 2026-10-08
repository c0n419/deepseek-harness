---
description: "在 Web 模式选择器中添加团队模式：由 Lead 智能体向 Claude Code、Codex、OpenCode 等外部编码智能体分派任务，每个智能体拥有自己的上下文、模型和 git 分支。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-team-mode-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-team-mode-profile` 在 Web 和 Desktop 的模式选择器中添加**团队模式**。在团队模式下，会话的智能体是 Lead，负责运营一个软件团队：它创建开发者，给他们分派任务，阅读他们的汇报，并合并他们的工作。开发者可以是 DSH 队友，也可以是外部编码智能体——Claude Code、Codex、OpenCode、omp、Gemini CLI 或 pi——作为独立进程运行，拥有自己的上下文、模型、git worktree 和分支。该 bundle 发布时默认关闭；在插件页面启用后，为新会话选择团队模式即可。

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

### 启用团队模式

在 Web 或 Desktop 的插件页面启用**团队模式**，或将该 bundle 添加到 CLI Web 配置：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-team-mode-profile
```

然后在新会话的模式选择器中选择**团队模式**并描述工作，例如：“用 claude 实现解析器，用 codex 编写它的测试，然后审查两个分支并合并。”

### 外部开发者

Lead 通过 `spawn_teammate({ name, description, prompt, harness })` 创建外部开发者。`harness` 是已配置的 harness 名称，可以在后面加上 `/<model>`，例如 `claude/sonnet` 或 `opencode/anthropic/claude-sonnet-4`。模型必须是该 harness 在其 ACP `model` 选项中提供的值；未知值会使该开发者的轮次失败，并列出可用值。每个外部开发者都需要在 Host 机器上安装并登录对应的 harness：

| Harness | 命令 | 登录 |
|---|---|---|
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp@0.87.0` | Claude Code 登录或 `ANTHROPIC_API_KEY` |
| `codex` | `npx -y @agentclientprotocol/codex-acp@2.1.1` | `codex login` 或 `OPENAI_API_KEY` |
| `opencode` | `opencode acp` | OpenCode 自身的提供方设置 |
| `omp` | `omp acp` | omp 自身的提供方设置 |
| `gemini` | `gemini --acp` | Gemini CLI 登录或 `GEMINI_API_KEY` |
| `pi` | `npx -y pi-acp@0.0.34` | pi 自身的提供方设置 |

每个开发者在 `~/.dsh/worktrees/<session id>` 中、在分支 `dsh-team/<session id>` 上工作，该分支从工作区仓库当前的 `HEAD` 创建。工作区必须是 git 仓库。由 Lead 审查并合并这些分支；DSH 不会合并或删除它们。如需更改 harness、权限、隔离方式或 worktree 目录，请修补顶层的 `llm-acp` 行；[`llm-acp` 参考](../llm-acp/README.zh.md#configuration)列出了所有字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

该包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。它插入 `ui-team-mode` 团队 UI 行、只注册一次进程级 `acp` 路由的 [`dsh-experimental-llm-acp`](../llm-acp/README.zh.md) 行，以及一个 id 为 `team` 的 `@deepseek-ai/dsh-agent-preset` 行。该预设复制 Standard 预设的插件，并把其中的委派组替换为一个 `cordis:group`：该组隔离 `agentTeams` 服务，挂载团队服务和带 `externalProvider: acp` 的团队工具。该路由放在预设之外，因为同一时刻可能有多个预设修订处于活动状态，而第二次注册 `acp` 会失败。外部开发者是一个可延续的子会话，其模型路由为 `acp`，工具范围为空：`llm-acp` 在外部智能体中运行它的轮次，团队服务把每个已结束轮次的回复转发给 Lead。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 团队 UI 行、`acp` 路由行和 `team` 预设行 |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 才是运行时内容 |
| [`locale/`](locale) | 插件页面的标题和描述 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [作为 LLM 路由的外部编码智能体](../llm-acp/README.zh.md)——进程、会话、worktree 和模型选择。
- [Agent Teams 服务](../agent-team/README.zh.md)——成员名册、持久消息、回复转发和任务看板。
- [Agent Teams 工具](../tool-agent-team/README.zh.md)——`spawn_teammate` 及其他团队工具。
- [Agent Teams profile](../agent-team-profile/README.zh.md)——在所有模式中启用 Agent Teams，但不含外部开发者。
- [实验性包](../README.zh.md)——孵化状态和发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 团队策略和工具

#### 模型看到的内容

Lead 看到的是去掉 `subagent` 和 `subagent_fork` 的 Standard 工具集，以及来自 [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.zh.md) 的团队工具和策略，其中包括外部队友段落和 `spawn_teammate` 的 `harness` 参数。外部开发者只看到文本：他们的首个提示以及之后来自 Lead 的消息。

#### Token 影响

该 bundle 不添加自己的提示文本；团队策略和工具 schema 由 `@deepseek-ai/dsh-experimental-tool-agent-team` 说明。

#### KV Cache 影响

只要 patch 和团队工具 schema 不变，该预设的组合就保持前缀稳定。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限手动启用**——该包发布时默认关闭；没有任何内置配置启用它。
- **复制的预设**——`team` 预设复制了 Standard 预设的插件列表；在更新此 patch 之前，Standard 之后的改动不会同步过来。
- **模式名称未本地化**——该预设设置了自己的英文名称和描述，因此模式选择器在所有语言下都显示英文。
- **不能与 Agent Teams profile 同时使用**——同时启用两个 bundle 会挂载两次团队 UI。
- **Host 前提条件**——每个 harness 都必须在 Host 上安装并登录；`npx` 会在首次使用时下载固定版本的适配器。
- **外部开发者没有沙箱**——在 `permission: allow` 下，它们自行批准自己的编辑和命令，并以 Host 用户的全部权限运行；worktree 隔离的是它们的分支，而不是它们的权限。
- **需要 git 工作区**——当会话工作区不是 git 仓库时，外部开发者会以 git 的错误失败。
- **agy**——Google Antigravity 的 `agy` 没有 ACP 模式；只有在核实其服务条款之后，才可将第三方 ACP 适配器添加为 harness。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
