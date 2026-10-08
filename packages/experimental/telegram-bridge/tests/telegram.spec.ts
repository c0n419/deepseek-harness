import { describe, expect, it, vi } from 'vitest'
import { delay, TelegramClient, TelegramError } from '../src/telegram.ts'

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, sleep = vi.fn(async (_ms: number) => {})) {
  return {
    sleep,
    client: new TelegramClient({ apiBaseUrl: 'https://tg.test', token: 'T', sendIntervalMs: 3000, fetch: fetchImpl, sleep }),
  }
}

describe('TelegramClient', () => {
  it('posts JSON to the bot method URL and returns the result', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond({ ok: true, result: { message_id: 5 } }))
    const { client: c } = client(fetchMock)
    await expect(c.call('sendMessage', { text: 'hi' })).resolves.toEqual({ message_id: 5 })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://tg.test/botT/sendMessage')
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({ text: 'hi' })
  })

  it('raises Telegram errors with the description or the HTTP status', async () => {
    const { client: c } = client(async () => respond({ ok: false, description: 'Bad Request: chat not found' }, 400))
    await expect(c.call('sendMessage', {})).rejects.toThrow('telegram sendMessage: Bad Request: chat not found')
    const { client: bare } = client(async () => respond({ ok: false }, 502))
    await expect(bare.call('getMe', {})).rejects.toThrow('telegram getMe: HTTP 502')
  })

  it('serializes writes, spaces them, and waits out flood control', async () => {
    const order: string[] = []
    let flooded = false
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const text = (JSON.parse(init?.body as string) as { text: string }).text
      if (text === 'b' && !flooded) {
        flooded = true
        return respond({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } }, 429)
      }
      order.push(text)
      return respond({ ok: true, result: text })
    })
    const { client: c, sleep } = client(fetchMock)
    const results = await Promise.all([c.enqueue('sendMessage', { text: 'a' }), c.enqueue('sendMessage', { text: 'b' })])
    expect(results).toEqual(['a', 'b'])
    expect(order).toEqual(['a', 'b'])
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3000, 2000, 3000])
  })

  it('surfaces non-flood failures from the queue and keeps serving later writes', async () => {
    const failing = (init?: RequestInit): boolean => (JSON.parse(init?.body as string) as { fail?: boolean }).fail === true
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => failing(init)
      ? respond({ ok: false, description: 'Forbidden' }, 403)
      : respond({ ok: true, result: 'ok' }))
    const { client: c } = client(fetchMock)
    await expect(c.enqueue('sendMessage', { fail: true })).rejects.toBeInstanceOf(TelegramError)
    await expect(c.enqueue('sendMessage', {})).resolves.toBe('ok')
    const { client: broken } = client(async () => { throw new TypeError('network down') })
    await expect(broken.enqueue('sendMessage', {})).rejects.toThrow('network down')
  })

  it('long-polls updates with the offset, timeout, and signal', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond({ ok: true, result: [{ update_id: 9 }] }))
    const { client: c } = client(fetchMock)
    const signal = new AbortController().signal
    await expect(c.getUpdates(4, 30, signal)).resolves.toEqual([{ update_id: 9 }])
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ signal })
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({ offset: 4, timeout: 30, allowed_updates: ['message'] })
  })

  it('uses the global fetch and a real delay by default', async () => {
    const fetchMock = vi.fn(async () => respond({ ok: true, result: true }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const c = new TelegramClient({ apiBaseUrl: 'https://tg.test', token: 'T', sendIntervalMs: 1 })
      await expect(c.enqueue('getMe', {})).resolves.toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('delay', () => {
  it('resolves after the delay and rejects when aborted', async () => {
    await expect(delay(1)).resolves.toBeUndefined()
    const controller = new AbortController()
    const pending = delay(60_000, controller.signal)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('delay aborted')
  })
})
