/** Transport against a real fake socket: one request per connection, streaming, caps, and teardown. */

import { describe, expect, it } from 'vitest'
import { HerdrClient, isRefusal } from '../src/connection.ts'
import { HerdrProtocolError } from '../src/protocol.ts'
import { startFakeHerdr } from './fake-herdr.ts'
import type { FakeHerdr } from './fake-herdr.ts'

async function withServer<T>(body: (server: FakeHerdr) => Promise<T>): Promise<T> {
  const server = await startFakeHerdr()
  try {
    return await body(server)
  } finally {
    await server.close()
  }
}

describe('HerdrClient unary calls', () => {
  it('dials once per call, so a second call on a live server works after the first connection closed', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      expect(await client.call('ping', {})).toEqual({ result: { type: 'pong', version: '0.8.2', protocol: 20, capabilities: { live_handoff: true } } })
      expect(await client.call('ping', {})).toEqual({ result: { type: 'pong', version: '0.8.2', protocol: 20, capabilities: { live_handoff: true } } })
      expect(server.requests.map(request => request.method)).toEqual(['ping', 'ping'])
    })
  })

  it('reports a server refusal as a value rather than throwing', async () => {
    await withServer(async (server) => {
      server.answer({ error: { code: 'pane_not_found', message: 'pane w9:p9 not found' } }, 'pane.read')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      const outcome = await client.call('pane.read', { pane_id: 'w9:p9', source: 'visible' })
      expect(isRefusal(outcome)).toBe(true)
      expect(outcome).toMatchObject({ refused: true, code: 'pane_not_found' })
    })
  })

  it('fails a call that never answers within the request budget', async () => {
    await withServer(async (server) => {
      server.answer({ hang: true }, 'ping')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 60, maxFrameBytes: 1 << 20 })
      await expect(client.call('ping', {})).rejects.toThrow('did not answer within 60ms')
    })
  })

  it('reports a missing socket and refuses to dial after close', async () => {
    await withServer(async (server) => {
      const missing = new HerdrClient({ socketPath: `${server.socketPath}.absent`, requestTimeoutMs: 500, maxFrameBytes: 1 << 20 })
      await expect(missing.call('ping', {})).rejects.toThrow()
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 500, maxFrameBytes: 1 << 20 })
      client.close('the service was disposed')
      await expect(client.call('ping', {})).rejects.toThrow('the service was disposed')
    })
  })

  it('rejects a reply line that carries neither result nor error', async () => {
    await withServer(async (server) => {
      // `result: undefined` serializes to no `result` key at all.
      server.answer({ result: undefined }, 'ping')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      await expect(client.call('ping', {})).rejects.toThrow('frame carries neither result nor error')
    })
  })
})

describe('HerdrClient subscription', () => {
  it('confirms the subscription, streams pushed events, and closes on demand', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      const seen: { event: string; line: string }[] = []
      let started = false
      client.observe({ event: (event, line) => { seen.push({ event, line }) }, failed: () => {} })
      const close = await client.subscribe([{ type: 'pane.updated' }], () => { started = true })
      expect(started).toBe(true)
      expect(server.requests.at(-1)?.params).toEqual({ subscriptions: [{ type: 'pane.updated' }] })
      server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"idle","revision":1}}}')
      await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
      expect(seen).toEqual([{ event: 'pane_updated', line: '{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"idle","revision":1}}}' }])
      close()
    })
  })

  it('reports a refused subscription, and a malformed frame after confirmation as a stream failure', async () => {
    await withServer(async (server) => {
      server.answer({ error: { code: 'pane_not_found', message: 'pane w9:p9 not found' } }, 'events.subscribe')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      await expect(client.subscribe([{ type: 'pane.agent_status_changed', pane_id: 'w9:p9' }], () => {}))
        .rejects.toThrow('subscription refused: pane_not_found')
    })
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      const failures: Error[] = []
      client.observe({ event: () => {}, failed: (error) => { failures.push(error) } })
      await client.subscribe([{ type: 'pane.updated' }], () => {})
      server.push('{"broken":')
      await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
      expect(failures).toHaveLength(1)
      expect(failures[0]).toBeInstanceOf(HerdrProtocolError)
      client.close('done')
    })
  })

  it('reports the connection ending before the subscription was confirmed', async () => {
    await withServer(async (server) => {
      // Hang on the subscribe so the server never confirms, then drop it: the
      // failure belongs to the subscription attempt, not to an open stream.
      server.answer({ hang: true }, 'events.subscribe')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      let reported = 0
      client.observe({ event: () => {}, failed: () => { reported += 1 } })
      const closing = client.subscribe([{ type: 'pane.updated' }], () => {})
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
      server.dropSubscription()
      await expect(closing).rejects.toThrow('subscription connection closed')
      expect(reported).toBe(0)
      client.close('done')
    })
  })

  it('reports the socket disappearing while a subscription is open as a stream failure', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      const failures: Error[] = []
      client.observe({ event: () => {}, failed: (error) => { failures.push(error) } })
      await client.subscribe([{ type: 'pane.updated' }], () => {})
      server.dropSubscription()
      await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
      expect(failures.map(error => error.message)).toEqual(['herdr: subscription connection closed'])
      client.close('done')
    })
  })

  it('rejects a subscription the server never confirms, within the request budget', async () => {
    await withServer(async (server) => {
      // The server accepts `events.subscribe` and never answers: without its own
      // timer, the confirmation would hold this promise forever.
      server.answer({ hang: true }, 'events.subscribe')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 60, maxFrameBytes: 1 << 20 })
      const started = Date.now()
      await expect(client.subscribe([{ type: 'pane.updated' }], () => {}))
        .rejects.toThrow('events.subscribe did not confirm within 60ms')
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(server.requests.at(-1)?.method).toBe('events.subscribe')
    })
  })

  it('delivers every frame of a burst on one subscription connection', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      const seen: string[] = []
      client.observe({ event: (name) => { seen.push(name) }, failed: () => {} })
      await client.subscribe([{ type: 'pane.updated' }], () => {})
      for (let index = 0; index < 5; index += 1) {
        server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"idle","revision":1}}}')
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 60) })
      expect(seen).toHaveLength(5)
      client.close('done')
    })
  })

  it('refuses to subscribe after close', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      client.close('the service was disposed')
      await expect(client.subscribe([], () => {})).rejects.toThrow('the service was disposed')
    })
  })
})

describe('HerdrClient framing caps', () => {
  it('treats a line over the accepted budget as a protocol failure', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 80 })
      // A server that writes more than the budget without ever terminating the
      // line is the hostile case: the client refuses to buffer it.
      server.answer({ hang: true }, 'ping')
      const pending = client.call('ping', {})
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
      server.writeToLast('x'.repeat(200))
      await expect(pending).rejects.toThrow('exceeds 80 bytes without a line terminator')
      await expect(client.call('ping', {})).rejects.toThrow()
    })
  })

  it('rejects a single terminated line over the budget', async () => {
    await withServer(async (server) => {
      server.answer({ result: { type: 'ok', padding: 'y'.repeat(200) } }, 'ping')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 80 })
      await expect(client.call('ping', {})).rejects.toThrow('exceeds the accepted budget')
    })
  })

  it('settles a call when the peer destroys the connection before replying', async () => {
    await withServer(async (server) => {
      server.answer({ drop: true }, 'ping')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      await expect(client.call('ping', {})).rejects.toThrow('connection closed before a reply')
    })
  })

  it('skips a bare terminator and delivers the event line after it', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      const events: string[] = []
      client.observe({ event: (name) => { events.push(name) }, failed: () => {} })
      await client.subscribe([{ type: 'pane.updated' }], () => {})
      // A bare terminator carries no frame; the reader must not treat it as one.
      server.push('')
      server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"idle","revision":1}}}')
      await new Promise<void>((resolve) => { setTimeout(resolve, 60) })
      expect(events).toEqual(['pane_updated'])
      client.close('done')
    })
  })

  it('reports a write failure on a socket that connected successfully', async () => {
    await withServer(async (server) => {
      server.answer({ hangUp: true }, 'ping')
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      await expect(client.call('ping', {})).rejects.toThrow()
    })
  })

  it('delivers a reply that arrives in two packets', async () => {
    await withServer(async (server) => {
      const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2_000, maxFrameBytes: 1 << 20 })
      expect(await client.call('ping', {})).toMatchObject({ result: { type: 'pong' } })
      expect(server.requests.at(-1)?.method).toBe('ping')
    })
  })
})
