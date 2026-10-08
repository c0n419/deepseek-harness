# Herdr

[English](herdr.md) | 中文

`ctx.herdr` 把一个运行中的 [Herdr](../../packages/experimental/herdr/README.zh.md) 终端复用器连接到 harness：向 Client 提供服务器工作区、标签、窗格与已识别 agent 的统一视图，以及 read、prompt、send-keys 与 focus 命令。[Web 面板](../../packages/experimental/client-ui-herdr/README.zh.md)渲染该视图，[可选 bundle](../../packages/experimental/herdr-bundle/README.zh.md)把服务与面板组合在一起，默认关闭，直到用户启用。

## 所有权与数据通路

Herdr 的服务器把工作区、标签、窗格与 agent 作为一份不属于任何 Session 的进程全局资源持有。因此该服务把它们作为 Remote 流而不是 Session 数据发布：`watch()` 先给出当前视图，再给出每一次合并后的变化，Client 重新加载后重新订阅，且不持久化任何内容。窗格文本不属于流；只有观察者正在显示的窗格会被读取，经由 `pane.read` 并拼接软换行。

每条命令都以窗格为寻址对象，而不是 agent 名称。`focus(paneId)` 与 `sendKeys(paneId, keys)` 通过服务器的 `pane.focus` 与 `pane.send_keys` 驱动该窗格，因此未运行 agent 的窗格同样可以聚焦、同样接受按键；`prompt(paneId, text)` 走 `agent.prompt`，对没有 agent 占用的窗格，服务器以 `agent_not_found` 作答。`prompt`、`sendKeys` 与 `focus` 返回成功或带消息的拒绝码，因此面板把 `agent_not_found`、`blocked` 或被拒绝的按键当作普通状态而不是失败来渲染。`read(paneId)` 把已消失的窗格报告为 `notFound`，这是正常的竞态，其行数预算取自 `readLines` 字段。`sendKeys` 只接受固定的按键集合——Escape、Ctrl+C、Enter、Up、Down、Y 与 N——并在任何字节到达窗格之前校验。

## 传输与连接状态

该服务直接连接服务器的 AF_UNIX socket，从不派生 `herdr` CLI。服务器对每条连接只回答一个请求，因此每个一元调用都会单独建立连接，而一条长驻的 `events.subscribe` 连接推送触发重新读取的事件；服务器接受订阅却始终不确认时，该连接在 `requestTimeoutMs` 内被关闭并重试，因此服务不会一边自称已连接一边停在半开 socket 上。

推送事件不会各自触发一次重新读取。每个事件都在 `outputCoalesceMs` 窗口之后安排一次读取，而读取进行期间到达的请求由随后的窗口处理，而不是再开一对连接——`pane.updated` 会在智能体面板每次重绘时触发，因此一段突发只变成一次快照。普通 shell 输出时不推送事件且 revision 不变，因此面板按每个视图携带的 `outputRefreshMs` 间隔重新读取所显示的面板。

连接时会校验协议号与服务器版本；不一致时发布带两个数字的 `incompatible`，而不是继续解析未知帧；socket 缺失或不可读时发布带原因的 `unavailable`。中断会以有界退避持续重试，因为 Herdr 通常在 harness 之后启动；两种状态都是面板渲染的视图数据，因此服务器未运行的可选 bundle 不会破坏 harness 组合。协议不一致是终止性的，不会被重试：循环停止，而下一次 `watch()`——也就是面板「重试」所打开的那一次——会重新探测服务器，因此升级后的服务器无需刷新页面即可恢复。

拓扑事件是全局的，而 per-pane 的 agent 状态事件需要 `pane_id`；因此窗格集合变化时会重建订阅，使之后创建的窗格仍能上报其状态迁移。

## 配置

`socketPath` 选择 API socket；省略时依次解析 `HERDR_SOCKET_PATH` 与 Herdr 配置目录下默认会话的 socket，配置为相对路径时在构造期报错。`requestTimeoutMs`、`reconnectInitialMs`、`reconnectMaxMs`、`maxFrameBytes`、`readLines`、`outputCoalesceMs` 与 `outputRefreshMs` 约束传输、重试节奏、重新读取窗口与面板刷新间隔，`expectedProtocol` 指明本构建所说的 socket 协议。

## 设计依据

[Herdr 状态决策](../../.agents/notes/implemented/architecture/2026-10-08-herdr-state-remote-stream.zh.md)解释为何该视图是宿主 Remote 流而不是 Session 事件，以及这些替代方案各自付出了什么。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxherdr--herdrservice"></a>

### `ctx.herdr` — `HerdrService`

Host-side Herdr service.

The connection is established lazily on the first watch or command, because a deployment may compose the plugin before Herdr starts; a load-time dial would make the harness's startup order a correctness requirement.

```ts cordis-catalog
/**
 * Watch the server's live state: the current view, then every coalesced
 * change, until the Client stops watching.
 * @param signal - carrier cancellation.
 * @returns every frame the stream publishes, current view first.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<HerdrView>

/**
 * Read one pane's recent text with soft wraps joined. The server pushes no
 * text, so this stays a lazy read of the pane a caller displays.
 *
 * The line budget is `readLines` from configuration rather than a parameter:
 * an optional Remote parameter is not expressible through the generated
 * descriptor, so a caller could not omit it.
 * @param paneId - pane to read.
 * @returns the pane's text, or `{notFound: true}` when the pane is gone.
 */
@Remote async read(paneId: HerdrPaneId): Promise<HerdrReadResult>

/**
 * Submit one prompt to the agent occupying a pane.
 *
 * `agent.prompt` addresses an agent, so a pane with no recognized agent is a
 * result (`agent_not_found`), never a throw: the caller asked about a pane and
 * the answer is that the pane has no agent to prompt.
 * @param paneId - pane whose agent receives the prompt.
 * @param text - prompt text, submitted with an encoded Enter.
 * @returns success, or the server's refusal code (`agent_blocked`, `agent_not_found`, …).
 */
@Remote async prompt(paneId: HerdrPaneId, text: string): Promise<HerdrCommandResult>

/**
 * Send logical keys to a pane. `pane.send_keys` addresses the pane itself, so
 * a shell without an agent accepts keys exactly as an agent's pane does.
 * @param paneId - pane to receive the keys.
 * @param keys - keys to send, restricted to the surface's allowlist.
 * @returns success, or an error result naming the rejected key.
 */
@Remote async sendKeys(paneId: HerdrPaneId, keys: readonly HerdrKey[]): Promise<HerdrCommandResult>

/**
 * Focus one pane, making it the server's focused pane.
 *
 * `pane.focus` addresses the pane directly, so every pane is focusable,
 * including a shell that hosts no agent.
 * @param paneId - pane to focus.
 * @returns success, or the server's refusal code.
 */
@Remote async focus(paneId: HerdrPaneId): Promise<HerdrCommandResult>

/**
 * Close the service: stop reconnecting, close the subscription, and await the
 * connection's release. Idempotent; later calls throw the recorded reason.
 * @returns after the subscription connection is closed.
 */
async dispose(): Promise<void>
```

Source: [`packages/experimental/herdr/src/index.ts`](../../packages/experimental/herdr/src/index.ts)
<!-- END GENERATED cordis-surface -->
