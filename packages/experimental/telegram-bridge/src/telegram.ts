/**
 * Minimal Telegram Bot API client: JSON method calls, one serialized outgoing queue that keeps a
 * minimum gap between chat writes and honors `retry_after`, and abortable long polling.
 * @module @deepseek-ai/dsh-experimental-telegram-bridge/telegram
 */

/** One update returned by `getUpdates`, reduced to the fields the bridge reads. */
export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
}

/** One incoming chat message, reduced to the fields the bridge reads. */
export interface TelegramMessage {
  readonly message_id: number
  readonly message_thread_id?: number
  readonly chat: { readonly id: number }
  readonly from?: { readonly id: number }
  readonly text?: string
}

/** The subset of `fetch` the client uses. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Options for one Telegram client. */
export interface TelegramClientOptions {
  /** Bot API base URL, without a trailing slash. */
  readonly apiBaseUrl: string
  /** Bot token issued by BotFather. */
  readonly token: string
  /** Minimum milliseconds between two queued writes. */
  readonly sendIntervalMs: number
  /** `fetch` implementation; tests replace it. */
  readonly fetch?: FetchLike
  /** Clock used to space writes; tests replace it. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** A failed Bot API call. */
export class TelegramError extends Error {
  /**
   * @param method - Bot API method that failed.
   * @param description - Telegram's error description.
   * @param retryAfterSeconds - Telegram's flood-control wait, when given.
   */
  constructor(readonly method: string, description: string, readonly retryAfterSeconds?: number) {
    super(`telegram ${method}: ${description}`)
    this.name = 'TelegramError'
  }
}

interface ApiResponse<T> {
  readonly ok: boolean
  readonly result?: T
  readonly description?: string
  readonly parameters?: { readonly retry_after?: number }
}

/**
 * Wait `ms` milliseconds, rejecting early when `signal` aborts.
 * @param ms - delay in milliseconds.
 * @param signal - optional cancellation.
 * @returns after the delay.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('delay aborted', { cause: signal?.reason }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Bot API client with a serialized, rate-limited write queue. */
export class TelegramClient {
  private readonly fetch: FetchLike
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: TelegramClientOptions) {
    this.fetch = options.fetch ?? fetch
    this.sleep = options.sleep ?? delay
  }

  /**
   * Call one Bot API method directly.
   * @param method - Bot API method name.
   * @param params - JSON parameters.
   * @param signal - optional cancellation.
   * @returns the method's `result`.
   */
  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.fetch(`${this.options.apiBaseUrl}/bot${this.options.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      ...signal === undefined ? {} : { signal },
    })
    const body = await response.json() as ApiResponse<T>
    if (!body.ok) {
      throw new TelegramError(method, body.description ?? `HTTP ${String(response.status)}`, body.parameters?.retry_after)
    }
    return body.result as T
  }

  /**
   * Queue one write behind earlier writes, spaced by `sendIntervalMs`, retrying once per flood-control wait.
   * @param method - Bot API method name.
   * @param params - JSON parameters.
   * @returns the method's `result`.
   */
  enqueue<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const run = this.tail.then(async () => {
      for (;;) {
        try {
          return await this.call<T>(method, params)
        } catch (error: unknown) {
          if (!(error instanceof TelegramError) || error.retryAfterSeconds === undefined) throw error
          await this.sleep(error.retryAfterSeconds * 1000)
        }
      }
    })
    this.tail = run.then(
      () => this.sleep(this.options.sendIntervalMs),
      () => this.sleep(this.options.sendIntervalMs),
    )
    return run
  }

  /**
   * Long-poll for updates after `offset`.
   * @param offset - first update id to return.
   * @param timeoutSeconds - Telegram long-poll timeout.
   * @param signal - cancellation that ends the poll.
   * @returns the new updates.
   */
  getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message'] }, signal)
  }
}
