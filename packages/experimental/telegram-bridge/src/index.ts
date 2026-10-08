/**
 * Telegram bridge: follows and steers every Session of every mode from a private Telegram forum
 * group. Each root Session gets a topic with a self-editing status card covering its teammates
 * and subagents, and notifications for finished turns, failures, and questions. Text posted in a
 * topic becomes a prompt, `/dur` stops the running turn, and approval requests arrive with
 * buttons that race the Web UI. `/yeni` starts a Session in a chosen project and mode. The
 * bridge polls the Bot API, so it needs no inbound port, and accepts input only from configured
 * users in the configured chat.
 * @module @deepseek-ai/dsh-experimental-telegram-bridge
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Launcher } from './launcher.ts'
import { bridgeDomain, type TopicRecord } from './storage.ts'
import { delay, TelegramClient, TelegramError, type TelegramCallbackQuery, type TelegramMessage } from './telegram.ts'
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
  /** Absolute directory where `/yeni` creates new git projects; unset offers only registered projects. */
  projectsDir?: string
  /** Minutes an unfinished `/yeni` stays answerable. */
  draftTtlMinutes: number
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
  projectsDir: z.string(),
  draftTtlMinutes: z.number().min(1).default(10),
})

type BridgeDomain = Domain<typeof bridgeDomain>

/** Approval request fields the bridge reads. */
interface ApprovalAsk {
  readonly agent: { readonly id: string }
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** Who settled an approval the bridge presented. */
interface ApprovalDecision {
  readonly outcome: ApprovalOutcome
  readonly via: 'telegram' | 'web' | 'cancelled'
}

const OUTCOME_LABELS: Readonly<Record<ApprovalOutcome, string>> = {
  'allowed-once': '✅ Onaylandı',
  'rejected': '❌ Reddedildi',
  'cancelled': '⏹ İptal edildi',
  'unavailable': '⚠️ Yanıtlanamadı',
}

const VIA_LABELS: Readonly<Record<ApprovalDecision['via'], string>> = {
  telegram: 'Telegram',
  web: 'web',
  cancelled: 'istek geri çekildi',
}

/** Runtime state shared by the event observer, card refresher, and poller. */
class Bridge {
  private domain: BridgeDomain | undefined
  private readonly creating = new Map<string, Promise<TopicRecord>>()
  private readonly names = new Map<string, string>()
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly client: TelegramClient,
    readonly tracker: SessionTracker,
    private readonly launcher: Launcher,
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
    const userId = message.from?.id
    if (userId === undefined || !this.trusted(message.chat.id, userId)) return
    const text = message.text?.trim() ?? ''
    const command = text.startsWith('/') ? text.split(/\s+/u)[0]?.replace(/@.*$/u, '') : undefined
    const thread = message.message_thread_id
    const rootId = thread === undefined ? undefined : this.rootOfThread(thread)
    const named = rootId === undefined && command === undefined && text !== '' ? await this.launcher.name(userId, text) : undefined
    let reply: string
    if (command === '/oturumlar' || command === '/sessions') {
      const roots = this.tracker.roots()
      reply = roots.length === 0
        ? 'Takip edilen oturum yok.'
        : roots.map(id => `${this.tracker.running(id) ? '🟢' : '⚪'} ${escapeHtml(this.tracker.topicName(id))}`).join('\n')
    } else if (command === '/yeni' || command === '/new') {
      reply = await this.launcher.start(userId, text.replace(/^\S+\s*/u, ''))
    } else if (named !== undefined) {
      reply = named
    } else if (rootId === undefined) {
      reply = command === undefined && text === ''
        ? ''
        : 'Bu komutu veya mesajı bir oturumun konusunda kullanın. Komutlar: /yeni, /oturumlar, /durum, /dur.'
    } else if (command === '/durum' || command === '/status') {
      reply = this.tracker.card(rootId)
    } else if (command === '/dur' || command === '/stop') {
      reply = await this.control(() => this.controller().cancel({ sessionId: SessionId(rootId) }), '⏹ Durdurma isteği gönderildi.')
    } else if (command !== undefined) {
      reply = 'Komutlar: /yeni, /oturumlar, /durum, /dur. Konuya yazdığınız düz metin oturuma iletilir.'
    } else if (text === '') {
      reply = ''
    } else {
      reply = await this.control(() => this.controller().prompt({
        requestId: brandString<SessionRequestId>(randomUUID()),
        sessionId: SessionId(rootId),
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000)), '📨 İletildi.')
    }
    if (reply === '') return
    await this.client.enqueue('sendMessage', {
      chat_id: this.config.chatId,
      ...thread === undefined ? {} : { message_thread_id: thread },
      text: reply,
      parse_mode: 'HTML',
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    })
  }

  /** Settle a presented approval from its inline button. */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    if (!this.trusted(query.message?.chat.id, query.from.id)) return
    const data = query.data ?? ''
    if (data.startsWith('nw:')) {
      const live = await this.launcher.press(query.from.id, data.slice(3))
      await this.client.enqueue('answerCallbackQuery', {
        callback_query_id: query.id,
        ...live ? {} : { text: 'Bu seçim artık geçerli değil; /yeni ile yeniden başlayın.' },
      })
      return
    }
    const [kind, id, choice] = data.split(':')
    const settle = kind === 'ap' && id !== undefined ? this.approvals.get(id) : undefined
    if (settle !== undefined) settle({ outcome: choice === 'a' ? 'allowed-once' : 'rejected', via: 'telegram' })
    await this.client.enqueue('answerCallbackQuery', {
      callback_query_id: query.id,
      ...settle === undefined ? { text: 'Bu onay artık geçerli değil.' } : {},
    })
  }

  /**
   * Present one approval request in its root topic and race it against the remaining answerers.
   * A Web answer or a withdrawn request settles it; when the Web has no answerer, the Telegram
   * buttons stay authoritative until pressed.
   * @param request - the pending approval.
   * @param next - the remaining answerer chain.
   * @returns the first decision.
   */
  async answerApproval(request: ApprovalAsk, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (this.domain === undefined) return await next()
    const id = randomUUID().slice(0, 8)
    const decided = Promise.withResolvers<ApprovalDecision>()
    this.approvals.set(id, decided.resolve)
    const onAbort = (): void => { decided.resolve({ outcome: 'cancelled', via: 'cancelled' }) }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const header = `🔔 <b>${escapeHtml(this.tracker.nameOf(request.agent.id))}</b> onay bekliyor: <code>${escapeHtml(request.toolName)}</code>${request.reason === undefined ? '' : ` — ${escapeHtml(request.reason)}`}`
    const presented = this.presentApproval(this.tracker.rootOf(request.agent.id), id, header)
    // A Web decision settles first; without one, only the Telegram buttons can, unless they were never sent.
    void next().then(
      (outcome) => { if (outcome !== 'unavailable') decided.resolve({ outcome, via: 'web' }) },
      () => undefined,
    ).then(() => presented).then((messageId) => {
      if (messageId === undefined) decided.resolve({ outcome: 'unavailable', via: 'web' })
    })
    const decision = await decided.promise
    this.approvals.delete(id)
    request.signal?.removeEventListener('abort', onAbort)
    const messageId = await presented
    if (messageId !== undefined) {
      this.report(this.client.enqueue('editMessageText', {
        chat_id: this.config.chatId,
        message_id: messageId,
        text: `${header}\n${OUTCOME_LABELS[decision.outcome]} (${VIA_LABELS[decision.via]})`,
        parse_mode: 'HTML',
      }).then(() => undefined))
    }
    return decision.outcome
  }

  /** Send the approval buttons; resolves to the message id, or undefined when sending failed. */
  private async presentApproval(rootId: string, id: string, text: string): Promise<number | undefined> {
    try {
      const topic = await this.topic(rootId)
      if (topic === undefined) return undefined
      const message = await this.client.enqueue<{ message_id: number }>('sendMessage', {
        chat_id: this.config.chatId,
        message_thread_id: topic.threadId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Onayla', callback_data: `ap:${id}:a` }, { text: '❌ Reddet', callback_data: `ap:${id}:r` }]] },
      })
      return message.message_id
    } catch (error: unknown) {
      this.ctx.logger.warn('telegram-bridge: presenting an approval failed: %s', String(error))
      return undefined
    }
  }

  private trusted(chatId: number | undefined, userId: number | undefined): boolean {
    return chatId === this.config.chatId && userId !== undefined && this.config.allowedUserIds.includes(userId)
  }

  private controller(): Context['sessionController'] {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new Error('oturum denetleyicisi kullanılamıyor')
    return controller
  }

  private async control(action: () => unknown, success: string): Promise<string> {
    try {
      await action()
      return success
    } catch (error: unknown) {
      return `⚠️ Yapılamadı: ${escapeHtml(error instanceof Error ? error.message : String(error))}`
    }
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
          if (update.callback_query !== undefined) await this.handleCallback(update.callback_query)
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
  const launcher = new Launcher(ctx, client, {
    chatId: config.chatId,
    projectsDir: config.projectsDir,
    draftTtlMs: config.draftTtlMinutes * 60_000,
  })
  const bridge = new Bridge(ctx, config, client, new SessionTracker({ excerptChars: config.excerptChars, webUrl: config.webUrl }), launcher)
  ctx.on('session/event', (session, event) => { bridge.observe(session, event) })
  // Prepended so the bridge presents every approval and races the Web answerer behind it.
  ctx.on('approval/request', (request, next) => bridge.answerApproval(request, next), true)
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
