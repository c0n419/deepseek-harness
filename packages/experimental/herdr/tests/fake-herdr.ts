/**
 * A fake Herdr server over the real newline-JSON socket protocol, so the specs
 * exercise framing, the one-request-per-connection contract, subscription
 * streaming, and error classification without a Herdr installation.
 *
 * Each connection answers exactly one request and then closes, matching the
 * live server. A `events.subscribe` request keeps its connection open and
 * streams whatever the queued pushes carry.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One request the fake server received, for assertions. */
export interface RecordedRequest {
  /** Method as the client wrote it. */
  method: string
  /** Parameters as the client wrote them. */
  params: Record<string, unknown>
  /** Correlation id as the client wrote it. */
  id: string
}

/**
 * How one request is answered.
 *
 * - `result`: the raw `result` payload, stringified into the reply envelope;
 * - `error`: refuse with this code and message;
 * - `hang`: accept the connection and never answer (timeout tests);
 * - `drop`: destroy the connection without answering (crash tests).
 */
export type Answer =
  | { result: unknown }
  | { error: { code: string; message: string } }
  | { hang: true }
  | { drop: true }
  | { hangUp: true }
  | { slow: { delayMs: number; result: unknown } }

/** The scriptable server handle a spec drives. */
export interface FakeHerdr {
  /** Absolute socket path the client must dial. */
  socketPath: string
  /** Every request received so far, in arrival order. */
  requests: RecordedRequest[]
  /**
   * Queue one frame to push to the most recent subscribed connection.
   * @param line - the raw event line, without its terminator.
   */
  push: (line: string) => void
  /**
   * Write raw bytes to the most recent connection, subscribed or not.
   * @param text - exact bytes to write.
   */
  writeToLast: (text: string) => void
  /** Close the most recent subscribed connection from the server side. */
  dropSubscription: () => void
  /** Highest number of requests that were open at the same time. */
  peakConcurrent: () => number
  /**
   * Highest number of *subscriptions* the server held open at the same time.
   * Unary calls dial and close per request, so only subscribed connections on one
   * live socket each answer "how many view streams exist right now".
   */
  peakLiveSubscriptions: () => number
  /**
   * Replace the answer for one method's subsequent requests.
   * @param answer - how to answer; omitted restores that method's default.
   * @param method - the wire method this answer applies to; defaults to `session.snapshot`.
   */
  answer: (answer: Answer | undefined, method?: string) => void
  /** Close the listener and remove the temporary directory. */
  close: () => Promise<void>
}

/** The default answer per method, overridable wholesale. */
function defaultAnswer(method: string, params: Record<string, unknown>): Answer {
  switch (method) {
    case 'ping':
      return { result: { type: 'pong', version: '0.8.2', protocol: 20, capabilities: { live_handoff: true } } }
    case 'session.snapshot':
      return { result: { type: 'session_snapshot', snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } } }
    case 'pane.read':
      return { result: { type: 'pane_read', read: { text: `read ${String(params.pane_id)}`, revision: 7, truncated: false } } }
    case 'pane.layout':
      return { result: { type: 'pane_layout', layout: { panes: [{ pane_id: params.pane_id, rect: { x: 0, y: 0, width: 132, height: 40 } }] } } }
    case 'events.subscribe':
      return { result: { type: 'subscription_started' } }
    default:
      return { result: { type: 'ok' } }
  }
}

/**
 * Start a fake Herdr server on a fresh temporary socket.
 * @returns the handle to drive and close.
 */
export async function startFakeHerdr(): Promise<FakeHerdr> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-herdr-fake-'))
  const socketPath = join(directory, 'herdr.sock')
  const requests: RecordedRequest[] = []
  const overrides = new Map<string, Answer>()
  let subscription: Socket | undefined
  let last: Socket | undefined
  let hangUpNext = false
  let open = 0
  let peak = 0
  const subscribed = new Set<Socket>()
  let peakSubscriptions = 0

  const server: Server = createServer((socket) => {
    let pending = ''
    last = socket
    socket.once('close', () => { subscribed.delete(socket) })
    socket.on('error', () => { /* a spec may drop the connection at any moment */ })
    if (hangUpNext) {
      hangUpNext = false
      // Close from the server side before reading: the client's write then fails
      // on a socket that connected successfully.
      socket.destroy()
      return
    }
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        if (line.length > 0) handle(socket, line)
        index = pending.indexOf('\n')
      }
    })
  })

  const handle = (socket: Socket, line: string): void => {
    const request = JSON.parse(line) as RecordedRequest
    requests.push(request)
    const subscribing = request.method === 'events.subscribe'
    if (subscribing) {
      subscription = socket
      subscribed.add(socket)
      peakSubscriptions = Math.max(peakSubscriptions, subscribed.size)
    }
    const answer = overrides.get(request.method) ?? defaultAnswer(request.method, request.params)
    if ('slow' in answer) {
      open += 1
      peak = Math.max(peak, open)
      setTimeout(() => {
        open -= 1
        socket.write(`${JSON.stringify({ id: request.id, result: answer.slow.result })}\n`)
        socket.end()
      }, answer.slow.delayMs)
      return
    }
    if ('hang' in answer) return
    if ('drop' in answer) {
      socket.destroy()
      return
    }
    const reply = 'error' in answer
      ? { id: request.id, error: answer.error }
      : { id: request.id, result: 'result' in answer ? answer.result : undefined }
    socket.write(`${JSON.stringify(reply)}\n`)
    if (subscribing && !('error' in answer)) return
    socket.end()
  }

  server.listen(socketPath)
  await new Promise<void>((resolve) => { server.once('listening', resolve) })

  return {
    socketPath,
    requests,
    push: (line) => { subscription?.write(`${line}\n`) },
    peakConcurrent: () => peak,
    peakLiveSubscriptions: () => peakSubscriptions,
    writeToLast: (text) => { last?.write(text) },
    dropSubscription: () => {
      subscription?.destroy()
      subscription = undefined
    },
    answer: (value, method = 'session.snapshot') => {
      if (value !== undefined && 'hangUp' in value) hangUpNext = true
      if (value === undefined) overrides.delete(method)
      else overrides.set(method, value)
    },
    close: async () => {
      subscription?.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
    },
  }
}
