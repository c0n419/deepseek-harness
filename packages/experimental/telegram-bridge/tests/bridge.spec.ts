import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Events } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { TrackedHeader } from '../src/tracker.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as bridge from '../src/index.ts'

interface Call {
  readonly method: string
  readonly params: Record<string, unknown>
}

const CHAT = -100
const OWNER = 42

/** In-memory Bot API: records calls and serves queued updates once. */
class FakeTelegram {
  readonly calls: Call[] = []
  /** `setMyCommands` parameters, kept apart from chat writes. */
  readonly menus: Record<string, unknown>[] = []
  private updates: unknown[] = []
  private nextUpdate = 1
  failNext: string | undefined

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = url.slice(url.lastIndexOf('/') + 1)
    const params = JSON.parse(init?.body as string) as Record<string, unknown>
    if (method === 'getUpdates') {
      if (this.updates.length === 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 20)
          init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
        })
      }
      const batch = this.updates
      this.updates = []
      return this.ok(batch)
    }
    if (method === 'setMyCommands') {
      this.menus.push(params)
      return this.ok(true)
    }
    this.calls.push({ method, params })
    if (this.failNext === method) {
      this.failNext = undefined
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: message is not modified' }), { status: 400 })
    }
    if (method === 'createForumTopic') return this.ok({ message_thread_id: 77 })
    if (method === 'sendMessage') return this.ok({ message_id: 500 + this.calls.length })
    if (method === 'pinChatMessage') return new Response(JSON.stringify({ ok: false, description: 'not enough rights' }), { status: 400 })
    return this.ok(true)
  }

  send(text: string, options: { chat?: number; from?: number; thread?: number } = {}): void {
    this.updates.push({
      update_id: this.nextUpdate++,
      message: {
        message_id: 1,
        chat: { id: options.chat ?? CHAT },
        ...options.from === -1 ? {} : { from: { id: options.from ?? OWNER } },
        ...options.thread === undefined ? {} : { message_thread_id: options.thread },
        ...text === '' ? {} : { text },
      },
    })
    this.updates.push({ update_id: this.nextUpdate++ })
  }

  press(data: string | undefined, options: { from?: number; chat?: number } = {}): void {
    this.updates.push({
      update_id: this.nextUpdate++,
      callback_query: {
        id: `cb-${String(this.nextUpdate)}`,
        from: { id: options.from ?? OWNER },
        ...data === undefined ? {} : { data },
        message: { message_id: 1, chat: { id: options.chat ?? CHAT } },
      },
    })
  }

  sent(method: string): Call[] {
    return this.calls.filter(call => call.method === method)
  }

  private ok(result: unknown): Response {
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

type FetchWrap = (fake: FakeTelegram['fetch']) => FakeTelegram['fetch']

const controller = {
  prompt: vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({ accepted: true as const })),
  cancel: vi.fn((_request: unknown) => ({ accepted: true as const })),
}

async function setup(config: Partial<bridge.Config> = {}, wrap: FetchWrap = fake => fake, withController = true) {
  const telegram = new FakeTelegram()
  vi.stubGlobal('fetch', wrap(telegram.fetch))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  controller.prompt.mockClear()
  controller.cancel.mockClear()
  if (withController) ctx.provide('sessionController', controller as Partial<Context['sessionController']> as Context['sessionController'])
  const fiber = await ctx.plugin(bridge, {
    botToken: 'T',
    chatId: CHAT,
    allowedUserIds: [OWNER],
    apiBaseUrl: 'https://tg.test',
    sendIntervalMs: 0,
    cardIntervalMs: 100,
    excerptChars: 100,
    pollTimeoutSeconds: 1,
    draftTtlMinutes: 10,
    ...config,
  })
  await vi.waitFor(() => { expect(ctx.storageDomain.get('telegram_bridge')).toBeDefined() })
  const emit = (fields: TrackedHeader, type: string, data?: unknown): void => {
    const header: Partial<Session['header']> = {
      id: SessionId(fields.id),
      ...fields.cwd === undefined ? {} : { cwd: fields.cwd },
      ...fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset },
      ...fields.parentSession === undefined ? {} : { parentSession: SessionId(fields.parentSession) },
    }
    ctx.emit('session/event', { header } as Partial<Session> as Session, { type, seq: 0, time: 0, data } as SessionEvent)
  }
  return { ctx, telegram, fiber, emit }
}

type ApprovalAsk = Parameters<Events['approval/request']>[0]

function ask(
  ctx: Context, agentId: string, web: () => Promise<ApprovalOutcome>, signal?: AbortSignal, withReason = true,
): Promise<ApprovalOutcome> {
  const request: ApprovalAsk = {
    agent: { id: agentId } as Partial<ApprovalAsk['agent']> as ApprovalAsk['agent'],
    toolName: 'bash',
    ...withReason ? { reason: 'rm <tmp>' } : {},
    ...signal === undefined ? {} : { signal },
  }
  return ctx.waterfall('approval/request', request, web)
}

function approvals(telegram: FakeTelegram): string[][] {
  return telegram.sent('sendMessage').flatMap((call) => {
    const markup = call.params.reply_markup as { inline_keyboard: { callback_data: string }[][] } | undefined
    return markup === undefined ? [] : [markup.inline_keyboard.flat().map(button => button.callback_data)]
  })
}

async function presented(telegram: FakeTelegram, count: number): Promise<string[]> {
  await vi.waitFor(() => { expect(approvals(telegram)).toHaveLength(count) })
  return approvals(telegram)[count - 1]!
}

describe('telegram-bridge plugin', () => {
  it('opens a topic with a pinned card for an active root Session and posts its notifications there', async () => {
    const { telegram, emit } = await setup({ webUrl: 'https://ows.test/' })
    const lead = { id: 'lead-1', cwd: '/w/proj', agentPreset: 'team' }
    emit(lead, 'session/title', { title: 'Bot karlılık' })
    expect(telegram.calls).toEqual([])
    emit(lead, 'turn/start')
    emit(lead, 'assistant/message', { message: { content: [{ type: 'text', text: 'Bitti' }] }, usage: { inputTokens: 10 } })
    emit(lead, 'turn/end', { reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(telegram.sent('sendMessage').length).toBeGreaterThanOrEqual(2) })
    expect(telegram.sent('createForumTopic')).toEqual([{ method: 'createForumTopic', params: { chat_id: CHAT, name: '[Team] Bot karlılık · proj' } }])
    const [card, note] = telegram.sent('sendMessage')
    expect(card?.params).toMatchObject({ message_thread_id: 77, disable_notification: true, parse_mode: 'HTML' })
    expect(card?.params.text).toContain('Web arayüzünde aç')
    expect(note?.params).toMatchObject({ message_thread_id: 77, disable_notification: false, text: '✅ Tur bitti.\n<blockquote>Bitti</blockquote>' })
    expect(telegram.sent('pinChatMessage')).toHaveLength(1)
    expect(telegram.menus.map(menu => menu.scope)).toEqual([{ type: 'chat', chat_id: CHAT }])
    expect((telegram.menus[0]?.commands as { command: string }[]).map(entry => entry.command)).toEqual(['yeni', 'oturumlar', 'durum', 'dur'])

    emit({ id: 'mate', parentSession: 'lead-1' }, 'turn/start')
    telegram.failNext = 'editMessageText'
    emit(lead, 'session/title', { title: 'Yeni başlık' })
    await vi.waitFor(() => { expect(telegram.sent('editForumTopic')).toHaveLength(1) })
    expect(telegram.sent('editForumTopic')[0]?.params.name).toBe('[Team] Yeni başlık · proj')
    await vi.waitFor(() => { expect(telegram.sent('editMessageText').length).toBeGreaterThanOrEqual(1) })
  })

  it('answers commands and forwards topic text from the owner only', async () => {
    const { telegram, emit } = await setup()
    emit({ id: 'lead-1' }, 'turn/start')
    await vi.waitFor(() => { expect(telegram.sent('pinChatMessage')).toHaveLength(1) })
    telegram.send('/oturumlar@owsservebot')
    telegram.send('/durum', { thread: 77 })
    telegram.send('/durum')
    telegram.send('merhaba', { thread: 77 })
    telegram.send('/dur', { thread: 77 })
    telegram.send('/bilinmeyen', { thread: 77 })
    telegram.send('', { thread: 77 })
    telegram.send('')
    telegram.send('/oturumlar', { from: 7 })
    telegram.send('/oturumlar', { chat: 5 })
    telegram.send('/oturumlar', { from: -1 })
    await vi.waitFor(() => { expect(telegram.sent('sendMessage').length).toBe(7) })
    const replies = telegram.sent('sendMessage').slice(1).map(call => call.params.text)
    expect(replies).toEqual([
      '🟢 [Oturum] lead-1',
      expect.stringContaining('🟢 Lead'),
      'Bu komutu veya mesajı bir oturumun konusunda kullanın. Komutlar: /yeni, /oturumlar, /durum, /dur.',
      '📨 İletildi.',
      '⏹ Durdurma isteği gönderildi.',
      'Komutlar: /yeni, /oturumlar, /durum, /dur. Konuya yazdığınız düz metin oturuma iletilir.',
    ])
    expect(controller.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'lead-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'merhaba' }],
    }), expect.any(AbortSignal))
    expect(controller.cancel).toHaveBeenCalledWith({ sessionId: 'lead-1' })
  })

  it('routes /yeni, its buttons, and a typed project name to the launcher', async () => {
    const { telegram } = await setup({ projectsDir: '/nowhere' })
    telegram.send('/yeni@owsservebot 2FA ekle')
    await vi.waitFor(() => { expect(telegram.sent('sendMessage')).toHaveLength(1) })
    const markup = telegram.sent('sendMessage')[0]?.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }
    telegram.press(markup.inline_keyboard[0]![0]!.callback_data)
    telegram.press('nw:stale:p:0')
    await vi.waitFor(() => { expect(telegram.sent('answerCallbackQuery')).toHaveLength(2) })
    expect(telegram.sent('answerCallbackQuery').map(call => call.params.text)).toEqual([undefined, 'Bu seçim artık geçerli değil; /yeni ile yeniden başlayın.'])
    telegram.send('demo')
    await vi.waitFor(() => { expect(telegram.sent('sendMessage')).toHaveLength(2) })
    expect(telegram.sent('sendMessage')[1]?.params.text).toBe('⚠️ Proje kaydı kullanılamıyor.')
  })

  it('reports failed controls and a missing Session controller', async () => {
    const withController = await setup()
    withController.emit({ id: 'lead-1' }, 'turn/start')
    await vi.waitFor(() => { expect(withController.telegram.sent('pinChatMessage')).toHaveLength(1) })
    controller.prompt.mockRejectedValueOnce(new Error('no live agent'))
    controller.cancel.mockImplementationOnce(() => { throw 'busy' })
    withController.telegram.send('devam et', { thread: 77 })
    withController.telegram.send('/stop', { thread: 77 })
    await vi.waitFor(() => { expect(withController.telegram.sent('sendMessage').length).toBe(3) })
    expect(withController.telegram.sent('sendMessage').slice(1).map(call => call.params.text))
      .toEqual(['⚠️ Yapılamadı: no live agent', '⚠️ Yapılamadı: busy'])

    const without = await setup({}, fake => fake, false)
    without.emit({ id: 'lead-1' }, 'turn/start')
    await vi.waitFor(() => { expect(without.telegram.sent('pinChatMessage')).toHaveLength(1) })
    without.telegram.send('/dur', { thread: 77 })
    await vi.waitFor(() => { expect(without.telegram.sent('sendMessage').length).toBe(2) })
    expect(without.telegram.sent('sendMessage')[1]?.params.text).toBe('⚠️ Yapılamadı: oturum denetleyicisi kullanılamıyor')
  })

  it('lists no Sessions before any turn and refreshes an existing topic after restart', async () => {
    const first = await setup()
    first.telegram.send('/sessions')
    await vi.waitFor(() => { expect(first.telegram.sent('sendMessage')).toHaveLength(1) })
    expect(first.telegram.sent('sendMessage')[0]?.params.text).toBe('Takip edilen oturum yok.')
    first.emit({ id: 'quiet' }, 'session/title', { title: 'never ran' })
    first.emit({ id: 'lead-1' }, 'turn/start')
    first.emit({ id: 'lead-1' }, 'turn/end', { reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(first.telegram.sent('sendMessage')).toHaveLength(3) })
    first.emit({ id: 'lead-1' }, 'turn/start')
    await vi.waitFor(() => { expect(first.telegram.sent('editMessageText').length).toBeGreaterThanOrEqual(1) })
    expect(first.telegram.sent('createForumTopic')).toHaveLength(1)
  })

  it('keeps polling after failures and survives a group without topics', async () => {
    let failPolls = 1
    const { telegram, emit } = await setup({}, fake => async (url, init) => {
      if (url.endsWith('/getUpdates') && failPolls-- > 0) throw new TypeError('offline')
      if (url.endsWith('/createForumTopic')) return new Response(JSON.stringify({ ok: false, description: 'not a forum' }), { status: 400 })
      return fake(url, init)
    })
    emit({ id: 'lead-x' }, 'turn/start')
    emit({ id: 'lead-x' }, 'turn/end', { reason: { kind: 'error', error: { message: 'boom' } } })
    telegram.send('/oturumlar')
    await vi.waitFor(() => { expect(telegram.sent('sendMessage')).toHaveLength(1) }, { timeout: 8000 })
    expect(telegram.sent('sendMessage')[0]?.params.text).toBe('⚪ [Oturum] lead-x')
  }, 10_000)

  it('waits for a turn before notifying, creates one topic for concurrent notifications, and handles unknown topics', async () => {
    const { telegram, emit } = await setup()
    const question = { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: 'Hangisi?' }] }) }
    emit({ id: 'lead-2' }, 'tool/call', question)
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(telegram.calls).toEqual([])
    emit({ id: 'lead-2' }, 'turn/start')
    emit({ id: 'lead-2' }, 'tool/call', question)
    emit({ id: 'lead-2' }, 'tool/call', question)
    await vi.waitFor(() => { expect(telegram.sent('sendMessage')).toHaveLength(3) })
    expect(telegram.sent('createForumTopic')).toHaveLength(1)
    telegram.send('/durum', { thread: 999 })
    await vi.waitFor(() => { expect(telegram.sent('sendMessage')).toHaveLength(4) })
    expect(telegram.sent('sendMessage')[3]?.params.text).toBe('Bu komutu veya mesajı bir oturumun konusunda kullanın. Komutlar: /yeni, /oturumlar, /durum, /dur.')
  })

  it('settles an approval from the Telegram buttons and ignores stale or foreign presses', async () => {
    const { ctx, telegram, emit } = await setup()
    emit({ id: 'lead-1' }, 'turn/start')
    emit({ id: 'dev-1', parentSession: 'lead-1' }, 'turn/start')
    const allowed = ask(ctx, 'dev-1', async () => 'unavailable')
    const [allow] = await presented(telegram, 1)
    const prompt = telegram.sent('sendMessage').at(-1)?.params
    expect(prompt?.message_thread_id).toBe(77)
    expect(String(prompt?.text)).toContain('onay bekliyor: <code>bash</code> — rm &lt;tmp&gt;')
    telegram.press(allow, { from: 7 })
    telegram.press(allow, { chat: 5 })
    telegram.press(allow)
    await expect(allowed).resolves.toBe('allowed-once')
    await vi.waitFor(() => { expect(telegram.sent('editMessageText').some(call => String(call.params.text).endsWith('✅ Onaylandı (Telegram)'))).toBe(true) })
    telegram.press(allow)
    telegram.press(undefined)
    await vi.waitFor(() => { expect(telegram.sent('answerCallbackQuery')).toHaveLength(3) })
    expect(telegram.sent('answerCallbackQuery').map(call => call.params.text)).toEqual([undefined, 'Bu onay artık geçerli değil.', 'Bu onay artık geçerli değil.'])

    const rejected = ask(ctx, 'lead-1', () => Promise.reject(new Error('no web')))
    const [, reject] = await presented(telegram, 2)
    telegram.press(reject)
    await expect(rejected).resolves.toBe('rejected')
  })

  it('lets a Web answer or a withdrawn request settle an approval', async () => {
    const { ctx, telegram, emit } = await setup()
    emit({ id: 'lead-1' }, 'turn/start')
    await expect(ask(ctx, 'lead-1', async () => 'allowed-once')).resolves.toBe('allowed-once')
    await vi.waitFor(() => { expect(telegram.sent('editMessageText').some(call => String(call.params.text).endsWith('✅ Onaylandı (web)'))).toBe(true) })

    const withdraw = new AbortController()
    const cancelled = ask(ctx, 'lead-1', async () => 'unavailable', withdraw.signal)
    await presented(telegram, 2)
    withdraw.abort()
    await expect(cancelled).resolves.toBe('cancelled')
    await vi.waitFor(() => { expect(telegram.sent('editMessageText').some(call => String(call.params.text).endsWith('(istek geri çekildi)'))).toBe(true) })
  })

  it('leaves an approval unavailable when neither the Web nor Telegram can answer', async () => {
    const { ctx, telegram, emit } = await setup()
    await expect(ask(ctx, 'ghost', async () => 'unavailable')).resolves.toBe('unavailable')
    emit({ id: 'lead-1' }, 'turn/start')
    await vi.waitFor(() => { expect(telegram.sent('createForumTopic')).toHaveLength(1) })
    telegram.failNext = 'sendMessage'
    await expect(ask(ctx, 'lead-1', async () => 'rejected')).resolves.toBe('rejected')
    telegram.failNext = 'sendMessage'
    await expect(ask(ctx, 'lead-1', async () => 'unavailable', undefined, false)).resolves.toBe('unavailable')
    expect(telegram.sent('editMessageText').filter(call => String(call.params.text).includes('onay bekliyor'))).toEqual([])
  })

  it('reports card refresh failures other than unchanged text', async () => {
    let failEdits = true
    const { telegram, emit } = await setup({}, fake => async (url, init) => {
      if (url.endsWith('/editMessageText') && failEdits) {
        failEdits = false
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })
      }
      return fake(url, init)
    })
    emit({ id: 'lead-3' }, 'turn/start')
    await vi.waitFor(() => { expect(telegram.sent('pinChatMessage')).toHaveLength(1) })
    emit({ id: 'lead-3' }, 'turn/end', { reason: { kind: 'aborted' } })
    await vi.waitFor(() => { expect(telegram.sent('sendMessage')).toHaveLength(2) })
    emit({ id: 'lead-3' }, 'turn/start')
    await vi.waitFor(() => { expect(telegram.sent('editMessageText').length).toBeGreaterThanOrEqual(1) })
  })

  it('stops a polling backoff when unloaded', async () => {
    let polls = 0
    const { fiber } = await setup({}, fake => async (url, init) => {
      if (url.endsWith('/getUpdates')) {
        polls += 1
        throw new TypeError('offline')
      }
      return fake(url, init)
    })
    await vi.waitFor(() => { expect(polls).toBe(1) })
    await fiber.dispose()
    expect(polls).toBe(1)
  })

  it('ignores events before storage opens and closes cleanly while opening', async () => {
    const telegram = new FakeTelegram()
    vi.stubGlobal('fetch', telegram.fetch)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const closed = vi.fn(async () => {})
    type OpenedDomain = Awaited<ReturnType<Context['storageDomain']['open']>>
    const opened = { close: closed } as Partial<OpenedDomain> as OpenedDomain
    const facility: Pick<Context['storageDomain'], 'get'> & { open: () => Promise<OpenedDomain> } = {
      open: async () => { await gate; return opened },
      get: () => undefined,
    }
    ctx.provide('storageDomain', facility as Partial<Context['storageDomain']> as Context['storageDomain'])
    const fiber = await ctx.plugin(bridge, { botToken: 'T', chatId: CHAT, allowedUserIds: [OWNER] } as bridge.Config)
    ctx.emit('session/event', { header: { id: SessionId('a') } } as Partial<Session> as Session, { type: 'turn/start', seq: 0, time: 0 } as SessionEvent)
    await expect(ask(ctx, 'a', async () => 'rejected')).resolves.toBe('rejected')
    const disposing = fiber.dispose()
    release()
    await disposing
    expect(closed).toHaveBeenCalled()
    expect(telegram.calls).toEqual([])
  })

  it('reports a storage that fails to open', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('storageDomain', {
      open: () => Promise.reject(new Error('disk full')),
      get: () => undefined,
    } as Partial<Context['storageDomain']> as Context['storageDomain'])
    const error = vi.spyOn(ctx.logger, 'error')
    await ctx.plugin(bridge, { botToken: 'T', chatId: CHAT, allowedUserIds: [OWNER] } as bridge.Config)
    await vi.waitFor(() => { expect(error.mock.calls.flat().join(' ')).toContain('disk full') })
  })

  it('reads the token from the environment and rejects incomplete configuration', () => {
    const ctx = new Context()
    const base = { chatId: CHAT, allowedUserIds: [OWNER], apiBaseUrl: 'x', sendIntervalMs: 0, cardIntervalMs: 100, excerptChars: 100, pollTimeoutSeconds: 1, draftTtlMinutes: 10 }
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    expect(() => { bridge.apply(ctx, base) }).toThrow('set botToken or TELEGRAM_BOT_TOKEN')
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'env-token')
    expect(() => { bridge.apply(ctx, { ...base, allowedUserIds: [] }) }).toThrow('allowedUserIds must name at least one user')
  })
})
