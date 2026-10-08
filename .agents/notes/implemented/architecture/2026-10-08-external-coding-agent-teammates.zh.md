# Agent Note: 作为 Agent Teams 队友的外部编码智能体

Status: implemented

[English](2026-10-08-external-coding-agent-teammates.md) | 中文

## 问题

团队模式让 Lead 运营一支软件团队，团队中的开发者是外部编码智能体——Claude Code、Codex、OpenCode、omp、Gemini CLI、pi——每个都有自己的上下文和模型。Agent Teams 已经拥有名册、持久邮箱、任务看板、等待／中断和 Web 面板，但每个队友都是由 DSH 循环驱动的进程内可延续子会话。延续管理器为每个子会话创建进程内 Agent，因此远程进程本身不能成为名册成员；现有的 ACP 子智能体后端是一次性的：打开会话、发送一个提示，然后退出。

## 决策

外部开发者是一个普通的可延续子会话，其模型路由是一个外部智能体。[`dsh-experimental-llm-acp`](../../../../packages/experimental/llm-acp/README.zh.md) 注册 `acp` LLM 路由：模型 `<harness>[/<model>]` 把会话绑定到一个长期运行的 ACP 智能体进程，每个请求发送最后一条助手消息之后的用户输入，流式返回的回答成为助手消息。因此名册、邮箱投递、恢复、任务看板和 Web 面板都无需第二种成员类型即可工作，Lead 看到的所有内容都在子会话日志中。该路由从不重试，因为重新发送提示会重复智能体的副作用。

`spawn_teammate({ harness })` 在该路由上以 `agentOptions` 和空工具范围创建子会话。对于工具范围中没有 `send_message` 的队友，tool-agent-team 不安装 Team 工具，团队服务会把该队友每个已结束轮次的文本作为团队消息转发给 Lead。该规则以工具范围而非路由来表述，因此适用于任何无法给 Lead 发消息的队友。`TeamMemberSnapshot.model` 记录所请求的路由，使 `list_agents` 在子会话未加载时也能显示它。

每个外部会话在自己的 git worktree 中、在分支 `dsh-team/<session id>` 上运行；由 Lead 审查并合并。模型通过智能体的 ACP `model` 会话配置选项选择（Claude Code、OpenCode 和 omp 都提供该选项），而不是使用各 harness 自己的命令行参数。

团队模式以可选启用的 [`dsh-experimental-team-mode-profile`](../../../../packages/experimental/team-mode-profile/README.zh.md) bundle 发布，它插入一个 `team` 预设，因为 `dsh-web-app` 等发布包不得依赖实验性包。

## 考虑过的替代方案

- **桥接到 herdr**——被产品负责人否决：herdr 是该能力的参考，而不是集成目标。
- **用 PTY 驱动交互式 TUI 并从屏幕抓取状态**——脆弱，而且终端后端不支持全屏程序。
- **独立的 `external` 名册成员类型**——需要为第二种身份类型重复实现邮箱投递、恢复和 Web 投影。
- **各 harness 的无头 CLI（`claude -p --resume`、`codex exec resume`、`pi --mode rpc`）**——每个 harness 一个驱动，而不是一个 ACP 驱动。

## 影响

一个驱动即可服务所有支持 ACP 的 harness，外部开发者出现在现有的名册、面板和会话日志中。代价是：外部轮次不报告 token 用量；只有文本会到达智能体；Host 重启后重放文本对话记录，而不是加载远程会话；权限请求按固定策略应答；`team` 预设复制了 Standard 的插件列表。
