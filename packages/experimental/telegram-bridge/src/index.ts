/**
 * Telegram bridge: follows every Session of every mode from a private Telegram forum group.
 * Each root Session gets a topic with a self-editing status card covering its teammates and
 * subagents, and notifications for finished turns, failures, approvals, and questions. The bridge
 * polls the Bot API, so it needs no inbound port, and accepts commands only from configured
 * users in the configured chat.
 * @module @deepseek-ai/dsh-experimental-telegram-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { bridgeDomain, type TopicRecord } from './storage.ts'
import { delay, TelegramClient, TelegramError, type TelegramMessage } from './telegram.ts'
import { escapeHtml, type Notification, SessionTracker } from './tracker.ts'

export { SessionTracker } from './tracker.ts'
export { TelegramClient } from './telegram.ts'

/** Cordis plugin name. */
export const name = 'telegram-bridge'
/** Services the bridge requires. */
export const inject = ['storageDomain']

/** Plugin configuration. */
export interface Config {
  /** Bot token; falls back to `$TELEGRAM_BOT_TOKEN`. */
  botToken?: string
  /** Forum supergroup chat id that holds one topic per root Session. */
  chatId: number
  /** Telegram user ids whose commands the bridge accepts. */
  allowedUserIds: number[]
  /** Bot API base URL. */
  apiBaseUrl: string
  /** Web UI URL linked from each status card. */
  webUrl?: string
  /** Minimum milliseconds between two Telegram writes; group chats allow about 20 messages per minute. */
  sendIntervalMs: number
  /** Milliseconds between status-card refreshes. */
  cardIntervalMs: number
  /** Maximum characters of agent text quoted in a notification. */
  excerptChars: number
  /** Telegram long-poll timeout in seconds. */
  pollTimeoutSeconds: number
}

export const Config: z<Config> = z.object({
  botToken: z.string(),
  chatId: z.number().required(),
  allowedUserIds: z.array(z.number()).required(),
  apiBaseUrl: z.string().default('https://api.telegram.org'),
  webUrl: z.string(),
  sendIntervalMs: z.number().min(0).default(3000),
  cardIntervalMs: z.number().min(100).default(5000),
  excerptChars: z.number().min(20).default(300),
  pollTimeoutSeconds: z.number().min(1).default(30),
})

type BridgeDomain = Domain<typeof bridgeDomain>

/** Runtime state shared by the event observer, card refresher, and poller. */
class Bridge {
  private domain: BridgeDomain | undefined
  private readonly creating = new Map<string, Promise<TopicRecord>>()
  private readonly names = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly client: TelegramClient,
    readonly tracker: SessionTracker,
  ) {}

  attach(domain: BridgeDomain): void {
    this.domain = domain
  }

  observe(session: Session, event: SessionEvent): void {
    if (this.domain === undefined) return
    const notifications = this.tracker.observe(session.header, event)
    for (const note of notifications) this.report(this.notify(note))
  }

  /** Refresh every changed status card and topic name. */
  async refresh(): Promise<void> {
    for (const rootId of this.tracker.takeDirty()) {
      const topic = await this.topic(rootId)
      if (topic === undefined) continue
      const name = this.tracker.topicName(rootId)
      if (this.names.get(rootId) !== name) {
        this.names.set(rootId, name)
        await this.ignoreUnchanged(this.client.enqueue('editForumTopic', { chat_id: this.config.chatId, message_thread_id: topic.threadId, name }))
      }
      await this.ignoreUnchanged(this.client.enqueue('editMessageText', {
        chat_id: this.config.chatId,
        message_id: topic.cardMessageId,
        text: this.tracker.card(rootId),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }))
    }
  }

  /** Handle one incoming message; messages from other chats or users are ignored. */
  async handle(message: TelegramMessage): Promise<void> {
    if (message.chat.id !== this.config.chatId) return
    if (message.from === undefined || !this.config.allowedUserIds.includes(message.from.id)) return
    const command = message.text?.trim().split(/\s+/u)[0]?.replace(/@.*$/u, '')
    const thread = message.message_thread_id
    const rootId = thread === undefined ? undefined : this.rootOfThread(thread)
    let reply: string
    if (command === '/oturumlar' || command === '/sessions') {
      const roots = this.tracker.roots()
      reply = roots.length === 0
        ? 'Takip edilen oturum yok.'
        : roots.map(id => `${this.tracker.running(id) ? '🟢' : '⚪'} ${escapeHtml(this.tracker.topicName(id))}`).join('\n')
    } else if (command === '/durum' || command === '/status') {
      reply = rootId === undefined ? 'Bu komutu bir oturumun konusunda kullanın.' : this.tracker.card(rootId)
    } else {
      reply = 'Komutlar: /oturumlar, /durum. Mesaj gönderme ve onaylar bir sonraki aşamada gelecek.'
    }
    await this.client.enqueue('sendMessage', {
      chat_id: this.config.chatId,
      ...thread === undefined ? {} : { message_thread_id: thread },
      text: reply,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
  }

  /** Poll Telegram until `signal` aborts. */
  async poll(signal: AbortSignal): Promise<void> {
    const stopped = (): boolean => signal.aborted
    while (!stopped()) {
      try {
        const cursor = this.domain?.table('cursor').get('updates')?.offset ?? 0
        const updates = await this.client.getUpdates(cursor, this.config.pollTimeoutSeconds, signal)
        for (const update of updates) {
          if (update.message !== undefined) await this.handle(update.message)
          await this.domain?.table('cursor').put('updates', { offset: update.update_id + 1 })
        }
      } catch (error: unknown) {
        if (stopped()) return
        this.ctx.logger.warn('telegram-bridge: polling failed: %s', String(error))
        await delay(5000, signal).catch(() => undefined)
      }
    }
  }

  private async notify(note: Notification): Promise<void> {
    const topic = await this.topic(note.rootId)
    if (topic === undefined) return
    await this.client.enqueue('sendMessage', {
      chat_id: this.config.chatId,
      message_thread_id: topic.threadId,
      text: note.text,
      parse_mode: 'HTML',
      disable_notification: !note.loud,
      link_preview_options: { is_disabled: true },
    })
  }

  /** Topic of a root Session, created with its status card once the Session has run a turn. */
  private topic(rootId: string): Promise<TopicRecord | undefined> {
    const existing = this.domain?.table('topics').get(rootId)
    if (existing !== undefined) return Promise.resolve(existing)
    if (!this.tracker.isActive(rootId)) return Promise.resolve(undefined)
    let pending = this.creating.get(rootId)
    if (pending === undefined) {
      pending = this.createTopic(rootId).finally(() => { this.creating.delete(rootId) })
      this.creating.set(rootId, pending)
    }
    return pending
  }

  private async createTopic(rootId: string): Promise<TopicRecord> {
    const name = this.tracker.topicName(rootId)
    const topic = await this.client.enqueue<{ message_thread_id: number }>('createForumTopic', { chat_id: this.config.chatId, name })
    this.names.set(rootId, name)
    const card = await this.client.enqueue<{ message_id: number }>('sendMessage', {
      chat_id: this.config.chatId,
      message_thread_id: topic.message_thread_id,
      text: this.tracker.card(rootId),
      parse_mode: 'HTML',
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    })
    const record = { threadId: topic.message_thread_id, cardMessageId: card.message_id }
    await this.domain?.table('topics').put(rootId, record)
    await this.client.enqueue('pinChatMessage', { chat_id: this.config.chatId, message_id: card.message_id, disable_notification: true })
      .catch((error: unknown) => {
        this.ctx.logger.debug('telegram-bridge: pinning the status card failed: %s', String(error))
      })
    return record
  }

  private rootOfThread(threadId: number): string | undefined {
    /* v8 ignore next -- commands are polled only after storage opens. */
    for (const [rootId, topic] of this.domain?.table('topics').entries() ?? []) {
      if (topic.threadId === threadId) return rootId
    }
    return undefined
  }

  private async ignoreUnchanged(write: Promise<unknown>): Promise<void> {
    try {
      await write
    } catch (error: unknown) {
      // Telegram rejects an edit that changes nothing; any other failure is reported.
      if (!(error instanceof TelegramError && error.message.includes('message is not modified'))) throw error
    }
  }

  private report(work: Promise<void>): void {
    work.catch((error: unknown) => {
      this.ctx.logger.warn('telegram-bridge: %s', String(error))
    })
  }

  /** Run one refresh and report its failure. */
  tick(): void {
    this.report(this.refresh())
  }
}

/**
 * Start the bridge: observe Session events, refresh cards, and poll for commands.
 * @param ctx - plugin context with `storageDomain`.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const token = config.botToken ?? launchEnvironmentOf(ctx).get('TELEGRAM_BOT_TOKEN')?.value
  if (token === undefined || token === '') throw new Error('telegram-bridge: set botToken or TELEGRAM_BOT_TOKEN')
  if (config.allowedUserIds.length === 0) throw new Error('telegram-bridge: allowedUserIds must name at least one user')
  const client = new TelegramClient({ apiBaseUrl: config.apiBaseUrl, token, sendIntervalMs: config.sendIntervalMs })
  const bridge = new Bridge(ctx, config, client, new SessionTracker({ excerptChars: config.excerptChars, webUrl: config.webUrl }))
  ctx.on('session/event', (session, event) => { bridge.observe(session, event) })
  ctx.effect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    const opened = ctx.storageDomain.open(bridgeDomain).then((domain) => {
      if (controller.signal.aborted) return domain.close()
      bridge.attach(domain)
      timer = setInterval(() => { bridge.tick() }, config.cardIntervalMs)
      void bridge.poll(controller.signal)
      return undefined
    })
    opened.catch((error: unknown) => {
      ctx.logger.error('telegram-bridge: opening storage failed: %s', String(error))
    })
    return async () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
      await opened.catch(() => undefined)
      await ctx.storageDomain.get('telegram_bridge')?.close()
    }
  }, 'telegram-bridge')
}
