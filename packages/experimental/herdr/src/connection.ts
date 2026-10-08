/**
 * The AF_UNIX transport: one short-lived connection per request and one
 * long-lived connection for the event subscription.
 *
 * The Herdr server answers exactly one request per connection and then closes,
 * so a pool would deadlock on the second call and every unary call must dial
 * afresh. The subscription connection is the opposite: it stays open after
 * `subscription_started` and pushes one envelope per event until either side
 * closes it.
 * @module @deepseek-ai/dsh-experimental-herdr/connection
 */

import { createConnection, type Socket } from 'node:net'
import { HerdrProtocolError, asError, parseEvent, parseFrame } from './protocol.ts'
import type { HerdrPane } from './types.ts'

/** A refused request as the transport reports it: the server answered `{id,error}`. */
export interface HerdrRefusal {
  /** Discriminant of a refused request. */
  refused: true
  /** Server error code. */
  code: string
  /** Server error message. */
  message: string
}

/** One unary result: either the parsed payload or a server refusal. */
export type HerdrCallResult = { result: unknown } | HerdrRefusal

/**
 * Test one call result for a refusal.
 * @param value - result of a unary call.
 * @returns whether the server refused the request.
 */
export function isRefusal(value: HerdrCallResult): value is HerdrRefusal {
  return 'refused' in value
}

/** Limits and timeouts one client instance applies to every connection. */
export interface HerdrClientOptions {
  /** Absolute path of the Herdr API socket. */
  socketPath: string
  /** Wall-clock budget for one round trip, in milliseconds. */
  requestTimeoutMs: number
  /** Maximum accepted bytes of one reply or event line. */
  maxFrameBytes: number
}

let frameSequence = 0

/** One subscriber of the event stream. */
export interface HerdrSubscription {
  /**
   * Called for every event envelope the server pushes, after the frame parses.
   * @param event - the server's event name.
   * @param line - the raw envelope, for callers that decode it themselves.
   */
  event: (event: string, line: string) => void
  /**
   * Called when the open stream fails: an unparseable frame, an oversized line,
   * or the connection ending. The stream is dead by then and must be reopened.
   * @param error - why the stream ended.
   */
  failed: (error: Error) => void
}

/**
 * A live connection to one Herdr server.
 *
 * Every method is safe to call after {@link close}: the client reports the
 * original close reason instead of dialing a socket it knows is gone.
 */
export class HerdrClient {
  private closed: string | undefined
  /** Every socket this client currently owns, so `close` can destroy them. */
  private readonly live = new Set<Socket>()

  /**
   * @param options - socket path and the two budgets every connection shares.
   */
  constructor(private readonly options: HerdrClientOptions) {}

  /**
   * Send one request and read its single reply.
   * @param method - wire method name.
   * @param params - method parameters in the server's spelling.
   * @returns the parsed payload, or the refusal the server answered with.
   * @throws HerdrProtocolError when a reply line is unparseable.
   */
  async call(method: string, params: Record<string, unknown>): Promise<HerdrCallResult> {
    if (this.closed !== undefined) throw new Error(`herdr: ${this.closed}`)
    const line = await this.roundTrip(method, params)
    const frame = parseFrame(line)
    return frame.error === undefined ? { result: frame.result } : { refused: true, ...frame.error }
  }

  /**
   * Open the one long-lived connection the view is maintained from.
   *
   * The returned handle resolves once the server confirmed the subscription and
   * runs until the connection ends or {@link close} is called. A refused
   * subscription rejects before any event is delivered.
   *
   * @param subscriptions - subscription descriptors in request order.
   * @param onStarted - called once the server confirmed the subscription.
   * @returns a disposer that closes this connection.
   * @throws HerdrProtocolError when the confirmation frame is unparseable.
   * @throws Error when the server refuses the subscription's descriptors, or does not confirm within the request budget.
   */
  async subscribe(subscriptions: readonly Record<string, unknown>[], onStarted: () => void): Promise<() => void> {
    if (this.closed !== undefined) throw new Error(`herdr: ${this.closed}`)
    const socket = await this.dial()
    const id = this.nextId('events.subscribe')
    let confirmed = false
    let disposed = false
    const confirmation = new Promise<void>((resolve, reject) => {
      // Before the confirmation frame every failure rejects this promise; after
      // it the same failures belong to the open stream and must not surface as
      // an unhandled rejection.
      const fail = (error: Error): (void) => {
        clearTimeout(timer)
        // A close this client asked for is not a failure: the caller is
        // replacing or releasing the subscription.
        if (disposed) return
        if (confirmed) this.subscriber?.failed(error)
        else reject(error)
      }
      // A server that accepts `events.subscribe` and never answers would
      // otherwise hold `connect()` forever, leaving the service looking
      // connected with no stream. The same budget as a round trip applies.
      const timer = setTimeout(() => {
        socket.destroy()
        fail(new Error(`herdr: events.subscribe did not confirm within ${String(this.options.requestTimeoutMs)}ms`))
      }, this.options.requestTimeoutMs)
      socket.once('close', () => { fail(new Error('herdr: subscription connection closed')) })
      this.readFrames(socket, (line) => {
        if (confirmed) {
          let event: { event: string; pane?: HerdrPane }
          try {
            event = parseEvent(line)
          } catch (error: unknown) {
            fail(asError(error))
            return
          }
          this.subscriber?.event(event.event, line)
          return
        }
        const frame = parseFrame(line)
        if (frame.error !== undefined) {
          clearTimeout(timer)
          reject(new Error(`herdr: subscription refused: ${frame.error.code}: ${frame.error.message}`))
          return
        }
        clearTimeout(timer)
        confirmed = true
        resolve()
        onStarted()
      }, fail)
    })
    socket.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } })}\n`)
    await confirmation
    return () => {
      disposed = true
      socket.destroy()
    }
  }

  /**
   * Close the client's own lifetime: every live connection is destroyed, so an
   * in-flight call fails immediately instead of waiting out its timeout, and
   * later calls fail with the reason.
   * @param reason - why the client is closing, reported to later callers.
   */
  close(reason: string): void {
    this.closed ??= reason
    for (const socket of this.live) socket.destroy()
    this.live.clear()
  }

  private subscriber: HerdrSubscription | undefined

  /**
   * Route every pushed envelope of the subscription to one handler.
   * @param subscription - handler for subsequent envelopes.
   */
  observe(subscription: HerdrSubscription): void {
    this.subscriber = subscription
  }

  private nextId(method: string): string {
    frameSequence += 1
    return `dsh-${method}-${String(frameSequence)}`
  }

  private async dial(): Promise<Socket> {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ path: this.options.socketPath })
      const onError = (error: Error): (void) => { socket.destroy(); reject(error) }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        // A failed write or a peer reset after connect surfaces here; without a
        // listener Node raises it as an unhandled 'error' event. The pending call
        // or stream reports the failure; this listener only keeps it handled.
        socket.on('error', () => {})
        // `close` may have run while this dial was in flight; a connection opened
        // after it must not outlive the client that already stopped.
        if (this.closed !== undefined) {
          socket.destroy()
          reject(new Error(`herdr: ${this.closed}`))
          return
        }
        this.live.add(socket)
        socket.once('close', () => { this.live.delete(socket) })
        resolve(socket)
      })
    })
  }

  /**
   * Dial, write one request, read exactly one reply line, then let the server
   * close. The timeout covers the whole exchange, so a server that accepts the
   * connection and never answers cannot hold a caller forever.
   */
  private async roundTrip(method: string, params: Record<string, unknown>): Promise<string> {
    const socket = await this.dial()
    const id = this.nextId(method)
    const reply = new Promise<string>((resolve, reject) => {
      // Exactly one of these settles: the reply, the request budget, the peer
      // vanishing, or a framing failure. A socket destroyed under us must settle
      // the call rather than leave it pending forever.
      let settled = false
      const settle = (done: () => void): (void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done()
      }
      const timer = setTimeout(() => {
        settle(() => { reject(new Error(`herdr: ${method} did not answer within ${String(this.options.requestTimeoutMs)}ms`)) })
        socket.destroy()
      }, this.options.requestTimeoutMs)
      socket.once('close', () => { settle(() => { reject(new Error(`herdr: ${method} connection closed before a reply`)) }) })
      this.readFrames(socket,
        (line) => { settle(() => { resolve(line) }) },
        (error) => { settle(() => { reject(error) }) })
    })
    socket.write(`${JSON.stringify({ id, method, params })}\n`)
    return await reply
  }

  /**
   * Read one line at a time, rejecting an oversized line rather than buffering
   * it. A line longer than the accepted budget is a hostile or broken peer, not
   * a large pane read.
   */
  private readFrames(socket: Socket, onLine: (line: string) => void, onError: (error: Error) => void): void {
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length > this.options.maxFrameBytes && !pending.includes(0x0a)) {
        socket.destroy()
        onError(new HerdrProtocolError(`herdr: frame exceeds ${String(this.options.maxFrameBytes)} bytes without a line terminator`))
        return
      }
      let index = pending.indexOf(0x0a)
      while (index >= 0) {
        const line = pending.subarray(0, index).toString('utf8')
        pending = pending.subarray(index + 1)
        if (line.length > this.options.maxFrameBytes) {
          socket.destroy()
          onError(new HerdrProtocolError(`herdr: frame of ${String(line.length)} bytes exceeds the accepted budget`))
          return
        }
        if (line.length > 0) onLine(line)
        index = pending.indexOf(0x0a)
      }
    })
  }
}
