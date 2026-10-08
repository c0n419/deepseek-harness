# Agent Note: Herdr 状态经宿主 Remote 流到达 GUI

Status: implemented

[English](2026-10-08-herdr-state-remote-stream.md) | 中文

## 问题

Herdr 是一个在 tmux 式标签页与窗格中运行编码 agent 的终端复用器，它的服务器把工作区、标签、窗格与 agent 状态作为一份进程全局资源持有，位于任何 harness Session 之外。多个窗格可能各自运行 harness Session，服务器也会在没有 harness 参与的情况下改变状态。Web 面板需要持续获得这些状态：带 per-agent 状态的工作区／标签／窗格树、所选窗格的输出，以及让 agent 提示、发送按键或移动焦点的命令。

Harness 已有一套把插件状态绑定到 GUI 的机制：写入日志的 Session 事件，由 Session 投影折叠后提供给 Client。它适合由某个 Session 拥有、并且必须能在重放中存续的状态。Herdr 状态两者皆非：它属于另一个服务器，不依赖 Session 而变化，还包含无界的窗格文本。把它记录为 Session 事件，就等于为没有任何 Session 产生的事实增加 `SessionEventMap` 成员，让日志按终端输出速率增长，并带上事件成员所隐含的持久化确认以及 TypeScript 与 Python SDK 预期输出，还会把一份全局资源绑定到单个 Session 的生命周期上。

## 决策

Herdr 状态经宿主专有的 Typert Remote 流到达 GUI，底层是一个直接的 socket 客户端，从不经过 Session 投影或 Session 事件。宿主包持有唯一一个以 `herdr` 为键的 Cordis 服务，`ctx.herdr` 是 herdr 状态的唯一所在；Client 插件贡献面板并挂载生成的 Remote 命名空间。

### 宿主与 Client 的数据通路

该服务继承 `TypertRemoteService`，遵循 [remote 方法调用](2026-08-02-typert-remote-method-calls.zh.md)与[双工流](2026-09-19-remote-duplex-stream.zh.md)决策中的规则。`@Remote({ mode: 'stream' }) watch(signal)` 每帧产出一份完整视图；可选的 `signal` 是流方法保留的最后一个参数，由 Gateway 追加。视图携带连接状态、工作区、标签、窗格与 agent 行，以及当前聚焦的窗格 id。一元 `@Remote` 方法承载命令：`read`、`prompt`、`sendKeys` 与 `focus`。命令失败是带 code 与 message 的结果值，而不是抛出的错误，因此 Client 把 `not_found`、`blocked` 与 `timeout` 渲染为普通状态。

窗格文本不属于流。Client 只为用户选中的窗格请求 `read`，并在该窗格更新时重新读取，因此空闲面板不会通过网络搬运终端输出。流每帧发送完整视图并对高频更新做合并，所以重连或重新加载的 Client 只需重新订阅，无需重放。

### Socket 传输与生命周期

该服务用换行分隔的 JSON 直接连接 herdr 服务器的 UNIX 域 socket，每个请求一条连接，并保持一条长驻订阅连接。它在运行期从不派生 `herdr` 命令：该 CLI 的默认动作是交互式复用器，派生进程还会引入 socket 协议本没有的终端所有权与生命周期问题。引导是一次 `session.snapshot` 请求；更新来自既有的 `events.subscribe` 订阅；socket 断开后以有界退避重连并重新发布视图。

连接状态是视图的一部分，而非失败：`connected` 携带服务器版本与协议号，`unavailable` 对应 socket 缺失或不可读，`incompatible` 指明期望与实际的协议号。启动失败会让服务停留在面板可渲染的降级状态，因为一个连不上自己服务器的可选 bundle 不得让宿主组合失败。

### 配置与部署

Socket 路径、请求超时、期望协议、重连上下界、帧字节上限、读取行数与输出合并都是经过校验的 `Config` 字段，socket 路径经由显式的 `resolveSocketPath(config, env)` 步骤解析，而不是在某次调用内部隐藏一个默认值。该 bundle 通过 `OPTIONAL_BUNDLES` 关闭发布，因此用户从插件管理器启用 herdr，而没有该服务器的安装只携带 socket 客户端。

## 考虑过的替代方案

**Session 事件加 Session 投影。** 这是 harness 已有的机制，Client 也不需要新 API。否决原因：窗格文本无界而日志是持久的，每一帧都会变成持久化事件，投影还需要为 Session 并不拥有的状态编写折叠逻辑。它还会为一份存在于日志之外的资源引入 `SessionEventMap` 成员、持久化格式确认与两个 SDK 的预期输出，而且重放会显示一段不一定与实时服务器一致的历史。

**按 Session 划分、每个 Session 一个 socket 的 Remote。** 每个 Session 得到自己的 herdr 客户端与自己的工作区列表。否决原因：窗格由服务器拥有，两个 Session 会持有同一份全局事实的分歧副本，而关闭一个 Session 会关闭其他窗格依赖的连接。

**只做面向模型的工具，不做 GUI 流。** 更省：模型通过工具读写窗格，用户直接看 herdr 的 TUI。否决原因：Web 面板的目的正是不离开 harness 就能看到 agent 状态与窗格输出，而且工具本身仍需要为每次模型可见的读取添加 Session 事件。

**每次操做都派生 `herdr` CLI。** 复用该 CLI 自己的传输，无需协议工作。否决原因：该 CLI 的默认动作是交互式复用器，变更类命令会在 harness 自身的所有权之外执行，而且每次读取的进程启动比一次 socket 调用更慢。

## 后果

Herdr 状态在 harness 重启后不留存，也不需要留存：它从服务器重新读取，Client 重新加载则重新订阅。herdr 的任何内容都不进入 Session 日志，因此没有持久化版本、SDK 预期输出或 Session 投影的变化。因此面板无法展示 herdr 历史，重放夹具也无法复现某个窗格的文本。

该服务持有 harness 未曾创建的连接，所以其生命周期是显式的：订阅携带调用方的 `AbortSignal`，析构会关闭 socket 并等待关闭完成，缺失服务器是上报的状态而非加载失败。由于只使用 socket 协议，harness 依赖的是 herdr 的线上格式而不是它的 CLI，期望协议号是一个配置字段，会以 `incompatible` 显式失败，而不是去解析未知帧。

GUI 的命令限于 read／prompt／send-keys／focus 这一子集；窗格与工作区的创建仍归 herdr 服务器，直到 harness 拥有该生命周期。后续面向模型的工具包会复用本服务，届时模型可见的任何内容再在此基础上成为 Session 事件。
