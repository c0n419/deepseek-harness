---
description: "通过已认证的 Web Remote 暴露 Herdr 服务端的工作区、窗格与编码代理，并提供提示词与按键控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-herdr

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-experimental-herdr` 将正在运行的 Herdr 终端复用器接入 harness。它直接连接 Herdr API 套接字，向客户端发布服务端工作区、标签页、窗格及已识别编码代理的完整视图，并提供 `prompt`、`sendKeys`、`focus` 与 `read` 命令。状态是 Remote 流而非会话数据：重载即重新订阅，不持久化任何内容。它从不启动 `herdr` CLI，因此任何集成步骤都不会启动复用器或其服务端。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

与 Typert 组合，并由客户端装配挂载生成的 `/remote` 贡献。`socketPath` 指定 API 套接字；省略时依次读取 `HERDR_SOCKET_PATH`、`<XDG_CONFIG_HOME 或 ~/.config>/herdr/herdr.sock`。`requestTimeoutMs` 限定一次往返与订阅握手；`reconnectInitialMs` 与 `reconnectMaxMs` 限定重连退避；`maxFrameBytes` 限定单条回复或事件行；`readLines` 设定惰性读取的行数预算；`outputCoalesceMs` 是将一阵事件合并为一帧发布与一次重读的窗口；`expectedProtocol` 是本构建所讲的套接字协议号。

套接字上没有服务端时，服务保持加载并报告 `unavailable` 连接，因为 Herdr 通常晚于 harness 启动，且服务端缺失不属于配置错误。服务端协议号不同时报告 `incompatible` 连接并给出两个数字，而不是继续执行；下一次 watch 会重新探测，因此服务端升级无需重新加载页面即可恢复。

`watch` 流每发布一帧产出一个完整的 `HerdrView`。所有命令都以窗格为目标：`read(paneId)` 返回窗格近期文本（行数预算来自 `readLines`），窗格已关闭时返回 `{ notFound: true }`；`focus(paneId)` 与 `sendKeys(paneId, keys)` 通过服务端的 `pane.*` 方法驱动该窗格，因此没有代理的 shell 也能被聚焦并接受按键；`prompt(paneId, text)` 提交给占用该窗格的代理。`prompt`、`sendKeys` 与 `focus` 在目标缺失或被阻塞时不会抛出，而是返回 `{ ok: false, code, message }`，对无代理窗格发起 prompt 会以该形式返回 `agent_not_found`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`resolveSocketPath` 在包边界上显式解析套接字。随后服务通过 `ping` 获取服务端版本与协议号，以一次 `session.snapshot` 作为启动视图，并开启一条长期存活的 `events.subscribe` 连接。每个推送事件都会触发一次快照重读：事件只携带单个窗格状态，而快照同时覆盖事件负载未包含的拓扑变化。流断开后以有界退避重连。

Herdr 服务端每条连接只应答一个请求随后关闭，因此每次一元调用都重新拨号，不存在连接池；订阅连接是唯一长期存活的套接字。窗格文本完全不会被推送，因此 `read` 始终是客户端显示某窗格时的惰性调用。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[实验性包](../README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为该服务代表浏览器驱动 Herdr 服务端，不注册任何面向模型的输入。

#### KV Cache effect

无直接影响；任何模型请求都不携带 Herdr 状态。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **每个服务实例一个服务端** — 只组合配置中指定的套接字；其他 Herdr 会话需要各自的配置行。
- **拓扑只读** — 创建、关闭、拆分、移动，以及所有 `server.*`、`worktree.*`、`plugin.*` 方法均不在范围内。服务读取结构，并驱动已存在的窗格。
- **不持久化状态** — 视图只存在于打开的流中；重载即重新订阅，Herdr 的任何信息都不会写入会话日志。
- **文本按需读取，不流式推送** — 服务端不推送窗格输出，因此客户端读取其显示的窗格，在下次读取前看不到更新。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
