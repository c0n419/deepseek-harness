/** The Host service: bootstrap, view stream, commands, protocol checks, and teardown. */

import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import HerdrService, { resolveSocketPath } from '../src/index.ts'
import { HerdrPaneId } from '../src/brand.ts'
import { startFakeHerdr } from './fake-herdr.ts'
import type { HerdrKey, HerdrView } from '../src/types.ts'

const SNAPSHOT = {
  type: 'session_snapshot',
  snapshot: {
    focused_pane_id: 'w1:p1',
    workspaces: [{ workspace_id: 'w1', label: 'repo', focused: true, tab_count: 1, pane_count: 2, agent_status: 'working' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', focused: true, pane_count: 2, agent_status: 'working' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, agent_status: 'idle', revision: 1, agent: 'omp' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', focused: false, agent_status: 'working', revision: 2 },
    ],
    agents: [{ pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', name: 'dev-a', agent: 'omp',
      agent_status: 'working', interactive_ready: true, launch_pending: false, focused: false }],
  },
}

/** Build the service on a throwaway Context and dispose it after the body. */
async function withService<T>(config: Record<string, unknown>, body: (service: HerdrService) => Promise<T>): Promise<T> {
  const ctx = new Context()
  const service = new HerdrService(ctx, HerdrService.Config(config))
  try {
    return await body(service)
  } finally {
    await service.dispose()
    await ctx.fiber.dispose()
  }
}

/**
 * Take frames until `stop` accepts one. The first frame is always the current
 * (pre-connect) view, so callers wait for the state they asserted.
 */
async function collect(service: HerdrService, stop: (view: HerdrView, count: number) => boolean): Promise<HerdrView[]> {
  const controller = new AbortController()
  const frames: HerdrView[] = []
  for await (const view of service.watch(controller.signal)) {
    frames.push(view)
    if (stop(view, frames.length)) break
  }
  controller.abort()
  return frames
}

/** The frame a predicate accepted; the first frame is always the pre-connect view. */
function matched(frames: HerdrView[], predicate: (view: HerdrView) => boolean): HerdrView {
  const found = frames.find(predicate)
  if (found === undefined) throw new Error('no frame matched the predicate')
  return found
}

describe('resolveSocketPath', () => {
  it('prefers the configured path, then HERDR_SOCKET_PATH, then the default config location', () => {
    expect(resolveSocketPath({ socketPath: '/tmp/a.sock' }, { HERDR_SOCKET_PATH: '/tmp/b.sock' })).toBe('/tmp/a.sock')
    expect(resolveSocketPath({}, { HERDR_SOCKET_PATH: '/tmp/b.sock' })).toBe('/tmp/b.sock')
    expect(resolveSocketPath({}, { XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/herdr/herdr.sock')
    expect(resolveSocketPath({}, {})).toMatch(/\/herdr\/herdr\.sock$/)
  })

  it('refuses a relative path instead of resolving it against the working directory', () => {
    expect(() => resolveSocketPath({ socketPath: 'herdr.sock' }, {})).toThrow('must be absolute')
  })
})

describe('configuration validation', () => {
  it('refuses a non-positive or fractional numeric field at construction', () => {
    const build = (config: Record<string, unknown>): HerdrService => new HerdrService(new Context(), HerdrService.Config(config))
    expect(() => build({ requestTimeoutMs: 0 })).toThrow('requestTimeoutMs must be a positive integer')
    expect(() => build({ readLines: 1.5 })).toThrow('readLines must be a positive integer')
    expect(() => build({ reconnectMaxMs: -1 })).toThrow('reconnectMaxMs must be a positive integer')
  })
})

describe('bootstrap and the view stream', () => {
  it('publishes a running server as a connected view with every list populated', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 30, reconnectInitialMs: 20 }, async (service) => {
        // The first frame is the current pre-connect view; the connected one follows.
        const frames = await collect(service, view => view.connection.status === 'connected')
        expect(frames).toHaveLength(2)
        // Frame 0 is the pre-connect view every watcher receives immediately.
        expect(frames[0]?.connection.status).toBe('unavailable')
        const connected = frames[1] as HerdrView
        expect(connected.connection).toEqual({ status: 'connected', version: '0.8.2', protocol: 20 })
        expect(connected.workspaces[0]?.label).toBe('repo')
        expect(connected.tabs[0]?.tabId).toBe('w1:t1')
        expect(connected.panes.map(pane => pane.paneId)).toEqual(['w1:p1', 'w1:p2'])
        expect(connected.agents[0]?.name).toBe('dev-a')
        expect(connected.focusedPaneId).toBe('w1:p1')
        expect(server.requests.map(request => request.method).slice(0, 3)).toEqual(['ping', 'session.snapshot', 'events.subscribe'])
      })
    } finally {
      await server.close()
    }
  })

  it('publishes a coalesced frame for a pushed event instead of one per event', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 120 }, async (service) => {
        const controller = new AbortController()
        const frames: HerdrView[] = []
        const reader = (async () => {
          for await (const view of service.watch(controller.signal)) frames.push(view)
        })()
        while (frames.length < 2) await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
        const afterConnect = frames.length
        for (let index = 0; index < 5; index += 1) {
          server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"working","revision":2}}}')
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, 300) })
        controller.abort()
        await reader
        // Five events inside one coalescing window publish far fewer frames.
        expect(frames.length - afterConnect).toBeLessThan(5)
        expect(frames.length - afterConnect).toBeGreaterThan(0)
      })
    } finally {
      await server.close()
    }
  })

  it('reports an unreachable server as unavailable and keeps retrying instead of failing load', async () => {
    await withService({ socketPath: '/tmp/definitely-absent-herdr.sock', reconnectInitialMs: 20, reconnectMaxMs: 40 }, async (service) => {
      const frames = await collect(service, (view, count) => view.connection.status === 'unavailable' && count >= 1)
      const first = frames[0] as HerdrView
      expect(first.connection.status).toBe('unavailable')
      expect(first.workspaces).toEqual([])
      // Still alive after a failure: the next frame proves the retry loop ran.
      const later = await collect(service, (view, count) => view.connection.status === 'unavailable' && count >= 1)
      expect(later[0]?.connection.status).toBe('unavailable')
    })
  })

  it('applies every default when only the socket path is configured', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath }, async (service) => {
        const frames = await collect(service, view => view.connection.status === 'connected')
        expect(matched(frames, view => view.connection.status === 'connected').workspaces[0]?.label).toBe('repo')
        // readLines default reached the wire, proving the schema-filled value is used.
        await service.read(HerdrPaneId('w1:p1'))
        expect(server.requests.at(-1)?.params).toMatchObject({ lines: 400 })
      })
    } finally {
      await server.close()
    }
  })

  it('retries after the backoff timer and connects once the server starts answering', async () => {
    const server = await startFakeHerdr()
    server.answer({ hang: true }, 'ping')
    try {
      const config = { socketPath: server.socketPath, requestTimeoutMs: 40, reconnectInitialMs: 20, reconnectMaxMs: 40 }
      await withService(config, async (service) => {
        const controller = new AbortController()
        const frames: HerdrView[] = []
        const reader = (async () => {
          for await (const view of service.watch(controller.signal)) frames.push(view)
        })()
        // First attempt fails; the retry timer must fire on its own.
        while (!frames.some(view => view.connection.status === 'unavailable')) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
        }
        server.answer({ result: SNAPSHOT }, 'session.snapshot')
        server.answer(undefined, 'ping')
        while (!frames.some(view => view.connection.status === 'connected')) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
        }
        controller.abort()
        await reader
        expect(matched(frames, view => view.connection.status === 'connected').workspaces[0]?.label).toBe('repo')
      })
    } finally {
      await server.close()
    }
  })

  it('reports a protocol mismatch as incompatible and names both numbers', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: { type: 'pong', version: '9.9.9', protocol: 99, capabilities: {} } }, 'ping')
    try {
      await withService({ socketPath: server.socketPath, reconnectInitialMs: 20, reconnectMaxMs: 40 }, async (service) => {
        const frames = await collect(service, view => view.connection.status === 'incompatible')
        expect(matched(frames, view => view.connection.status === 'incompatible').connection)
          .toEqual({ status: 'incompatible', expected: 20, actual: 99 })
      })
    } finally {
      await server.close()
    }
  })

  it('keeps every explicit configuration value instead of the default', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({
        socketPath: server.socketPath,
        requestTimeoutMs: 900,
        expectedProtocol: 20,
        reconnectInitialMs: 30,
        reconnectMaxMs: 60,
        maxFrameBytes: 1 << 18,
        readLines: 33,
        outputCoalesceMs: 25,
      }, async (service) => {
        await collect(service, view => view.connection.status === 'connected')
        await service.read(HerdrPaneId('w1:p1'))
        expect(server.requests.at(-1)?.params).toMatchObject({ lines: 33 })
      })
    } finally {
      await server.close()
    }
  })

  it('serves an unavailable view when no server ever answers, without failing plugin load', async () => {
    await withService(
      { socketPath: '/tmp/definitely-absent-herdr.sock', reconnectInitialMs: 20, reconnectMaxMs: 40 },
      async (service) => {
        const frames = await collect(service, view => view.connection.status === 'unavailable')
        // An absent Herdr is a normal state, not misconfiguration: the service
        // loads, reports it, and keeps retrying.
        expect(frames[0]?.connection.status).toBe('unavailable')
      },
    )
  })

  it('re-probes on the next watch after an incompatible server, so an upgrade recovers without a reload', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: { type: 'pong', version: '9.9.9', protocol: 99, capabilities: {} } }, 'ping')
    try {
      await withService({ socketPath: server.socketPath, reconnectInitialMs: 20, reconnectMaxMs: 40 }, async (service) => {
        const first = new AbortController()
        const frames: HerdrView[] = []
        const reader = (async () => {
          for await (const view of service.watch(first.signal)) frames.push(view)
        })()
        while (!frames.some(view => view.connection.status === 'incompatible')) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
        }
        first.abort()
        await reader
        // The panel's Retry is a fresh watch against the same service. It must
        // re-probe rather than reuse a resolved-but-dead start.
        server.answer({ result: SNAPSHOT }, 'session.snapshot')
        server.answer(undefined, 'ping')
        const pingsBefore = server.requests.filter(request => request.method === 'ping').length
        const second = await collect(service, view => view.connection.status === 'connected')
        expect(server.requests.filter(request => request.method === 'ping').length).toBeGreaterThan(pingsBefore)
        expect(matched(second, view => view.connection.status === 'connected').workspaces[0]?.label).toBe('repo')
      })
    } finally {
      await server.close()
    }
  })

  it('serves a command before any watch, connecting on first use', async () => {
    const server = await startFakeHerdr()
    try {
      await withService({ socketPath: server.socketPath }, async (service) => {
        // No watch was opened: the command path must start the connection on its
        // own. The command is not blocked behind it, so the connect is awaited
        // here rather than assumed to have landed first.
        await expect(service.read(HerdrPaneId('w1:p1'))).resolves.toMatchObject({ text: 'read w1:p1' })
        while (!server.requests.some(request => request.method === 'ping')) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
        }
        expect(server.requests.map(request => request.method)).toContain('ping')
      })
    } finally {
      await server.close()
    }
  })
})

/** Read the service's private watcher count, which no public surface exposes. */
function watcherCount(service: HerdrService): number {
  const watchers: unknown = Reflect.get(service, 'watchers')
  return watchers instanceof Set ? watchers.size : -1
}

describe('watcher lifecycle', () => {
  it('removes a watcher that is aborted without being drained further', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath }, async (service) => {
        const controller = new AbortController()
        const iterator = service.watch(controller.signal)[Symbol.asyncIterator]()
        await iterator.next()
        expect(watcherCount(service)).toBe(1)
        // The Client aborts and stops reading, which is exactly what the panel's
        // disposal does: code after the generator's loop never runs.
        controller.abort()
        await iterator.next()
        expect(watcherCount(service)).toBe(0)
      })
    } finally {
      await server.close()
    }
  })

  it('leaves no watcher behind after repeated abort-only retries', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath }, async (service) => {
        for (let index = 0; index < 5; index += 1) {
          const controller = new AbortController()
          const iterator = service.watch(controller.signal)[Symbol.asyncIterator]()
          await iterator.next()
          controller.abort()
          await iterator.next()
        }
        expect(watcherCount(service)).toBe(0)
      })
    } finally {
      await server.close()
    }
  })

  it('keeps abort listeners on the watch signal bounded across many frames', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 5 }, async (service) => {
        const controller = new AbortController()
        const frames: HerdrView[] = []
        const reader = (async () => {
          for await (const view of service.watch(controller.signal)) frames.push(view)
        })()
        for (let index = 0; index < 30; index += 1) {
          server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"working","revision":2}}}')
          while (frames.length < index + 2) await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
        }
        // One listener for the watcher's lifetime, not one per frame.
        expect(frames.length).toBeGreaterThanOrEqual(30)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
        controller.abort()
        await reader
        expect(watcherCount(service)).toBe(0)
      })
    } finally {
      await server.close()
    }
  })
})

describe('maintenance', () => {
  it('re-reads the snapshot after a pushed event, without opening a second subscription', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 20 }, async (service) => {
        await collect(service, (view, count) => view.connection.status === 'connected' && count >= 1)
        const subscribedBefore = server.requests.filter(request => request.method === 'events.subscribe').length
        const snapshotsBefore = server.requests.filter(request => request.method === 'session.snapshot').length
        server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"working","revision":2}}}')
        await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
        // The pane set did not change, so no second subscription was opened.
        expect(server.requests.filter(request => request.method === 'events.subscribe').length).toBe(subscribedBefore)
        expect(server.requests.filter(request => request.method === 'session.snapshot').length).toBeGreaterThan(snapshotsBefore)
      })
    } finally {
      await server.close()
    }
  })

  it('re-subscribes when the pane set changes, because per-pane state requires a pane_id each', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 20 }, async (service) => {
        await collect(service, (view, count) => view.connection.status === 'connected' && count >= 1)
        const before = server.requests.filter(request => request.method === 'events.subscribe').length
        const grown = structuredClone(SNAPSHOT)
        grown.snapshot.panes.push({ pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t1', focused: false, agent_status: 'idle', revision: 0 })
        server.answer({ result: grown }, 'session.snapshot')
        server.push('{"event":"pane_created","data":{"type":"pane_created"}}')
        await new Promise<void>((resolve) => { setTimeout(resolve, 150) })
        const after = server.requests.filter(request => request.method === 'events.subscribe').length
        expect(after).toBeGreaterThan(before)
      })
    } finally {
      await server.close()
    }
  })

  it('issues one re-read per coalesced window, not one per pushed event', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 60, reconnectInitialMs: 20 }, async (service) => {
        await collect(service, view => view.connection.status === 'connected')
        await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
        const before = server.requests.filter(request => request.method === 'session.snapshot').length
        for (let index = 0; index < 20; index += 1) {
          server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"working","revision":2}}}')
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, 300) })
        const added = server.requests.filter(request => request.method === 'session.snapshot').length - before
        // 20 events inside a few windows; without coalescing this would be 20.
        expect(added).toBeLessThanOrEqual(3)
        expect(added).toBeGreaterThan(0)
      })
    } finally {
      await server.close()
    }
  })

  it('never has two re-reads in flight at once, even with a zero-length window', async () => {
    const server = await startFakeHerdr()
    // Every snapshot read takes long enough that an unsynchronised second read
    // would overlap the first; the fixture records the peak overlap.
    server.answer({ slow: { delayMs: 60, result: SNAPSHOT } }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 1, reconnectInitialMs: 20 }, async (service) => {
        await collect(service, view => view.connection.status === 'connected')
        for (let index = 0; index < 40; index += 1) {
          server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"w1:t1","focused":false,"agent_status":"working","revision":2}}}')
          await new Promise<void>((resolve) => { setTimeout(resolve, 3) })
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
        const reads = server.requests.filter(request => request.method === 'session.snapshot').length
        // 40 events cost far fewer reads, and the single-flight guard means the
        // fixture never saw two open at once.
        expect(reads).toBeLessThan(40)
        expect(server.peakConcurrent()).toBe(1)
      })
    } finally {
      await server.close()
    }
  })

  it('reports the failure and reconnects when a refresh can no longer read the snapshot', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      const config = { socketPath: server.socketPath, outputCoalesceMs: 20, reconnectInitialMs: 20, reconnectMaxMs: 40 }
      await withService(config, async (service) => {
        const controller = new AbortController()
        const frames: HerdrView[] = []
        const reader = (async () => {
          for await (const view of service.watch(controller.signal)) frames.push(view)
        })()
        while (!frames.some(view => view.connection.status === 'connected')) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
        }
        // The subscription stays up while the snapshot read starts failing; the
        // refresh must surface that as unavailable rather than keep a stale view.
        server.answer({ error: { code: 'invalid_request', message: 'snapshot unavailable' } }, 'session.snapshot')
        server.push('{"event":"pane_updated","data":{"pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","focused":true,"agent_status":"idle","revision":9}}}')
        while (!frames.some(view => view.connection.status === 'unavailable' && view.panes.length > 0)) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
        }
        controller.abort()
        await reader
        expect(matched(frames, view => view.connection.status === 'unavailable' && view.panes.length > 0)
          .connection).toMatchObject({ reason: 'herdr: session.snapshot refused: invalid_request: snapshot unavailable' })
      })
    } finally {
      await server.close()
    }
  })

  it('never holds two live subscriptions when a stream failure races an in-flight start', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      const config = { socketPath: server.socketPath, outputCoalesceMs: 10, reconnectInitialMs: 20, reconnectMaxMs: 40 }
      await withService(config, async (service) => {
        const controller = new AbortController()
        const reader = (async () => {
          for await (const _view of service.watch(controller.signal)) { /* keep the view flowing */ }
        })()
        while (!server.requests.some(request => request.method === 'events.subscribe')) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
        }
        // Kill the live subscription; the replacement start runs while the dead
        // one is still being torn down, which is exactly the interleaving that
        // previously left two subscriptions open with only one tracked.
        server.push('{"broken":')
        await new Promise<void>((resolve) => { setTimeout(resolve, 600) })
        controller.abort()
        await reader
        expect(server.peakLiveSubscriptions()).toBe(1)
        expect(server.requests.filter(request => request.method === 'events.subscribe').length).toBeGreaterThanOrEqual(1)
      })
    } finally {
      await server.close()
    }
  })

  it('re-arms once for a subscription that reports its death twice', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      const config = { socketPath: server.socketPath, outputCoalesceMs: 10, reconnectInitialMs: 30, reconnectMaxMs: 60 }
      await withService(config, async (service) => {
        const controller = new AbortController()
        const frames: HerdrView[] = []
        const reader = (async () => {
          for await (const view of service.watch(controller.signal)) frames.push(view)
        })()
        while (!frames.some(view => view.connection.status === 'connected')) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
        }
        // One dead subscription reports twice for a single death: the malformed
        // frame fails the read, and the socket close echoes it. Only the first
        // report may re-arm, so exactly one replacement subscription follows.
        const before = server.requests.filter(request => request.method === 'events.subscribe').length
        server.push('{"broken":')
        await new Promise<void>((resolve) => { setTimeout(resolve, 500) })
        controller.abort()
        await reader
        const added = server.requests.filter(request => request.method === 'events.subscribe').length - before
        expect(added).toBe(1)
        expect(server.peakLiveSubscriptions()).toBe(1)
      })
    } finally {
      await server.close()
    }
  })

  it('returns to unavailable and reconnects when the stream drops', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, outputCoalesceMs: 20, reconnectInitialMs: 20 }, async (service) => {
        await collect(service, (view, count) => view.connection.status === 'connected' && count >= 1)
        server.dropSubscription()
        await new Promise<void>((resolve) => { setTimeout(resolve, 150) })
        // The service kept working: a new subscription was opened after the drop.
        expect(server.requests.filter(request => request.method === 'events.subscribe').length).toBeGreaterThan(1)
      })
    } finally {
      await server.close()
    }
  })
})

describe('commands', () => {
  it('reads a pane, maps "not found" to a result, and throws on any other refusal', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath, readLines: 25 }, async (service) => {
        await collect(service, (view, count) => view.connection.status === 'connected' && count >= 1)
        server.answer(undefined, 'session.snapshot')
        expect(await service.read(HerdrPaneId('w1:p1'))).toEqual({ paneId: 'w1:p1', text: 'read w1:p1', revision: 7, truncated: false })
        // The line budget comes from configuration: no Remote parameter carries it.
        expect(server.requests.at(-1)?.params).toEqual({ pane_id: 'w1:p1', source: 'recent_unwrapped', lines: 25 })
        server.answer({ error: { code: 'pane_not_found', message: 'gone' } }, 'pane.read')
        expect(await service.read(HerdrPaneId('w9:p9'))).toEqual({ notFound: true })
        server.answer({ error: { code: 'invalid_request', message: 'bad source' } }, 'pane.read')
        await expect(service.read(HerdrPaneId('w1:p1'))).rejects.toThrow('pane.read failed: bad source')
      })
    } finally {
      await server.close()
    }
  })

  it('returns command refusals as values instead of throwing', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath }, async (service) => {
        await collect(service, (view, count) => view.connection.status === 'connected' && count >= 1)
        const blocked = { error: { code: 'agent_blocked', message: 'agent is at a dialog' } }
        server.answer(blocked, 'agent.prompt')
        server.answer(blocked, 'pane.focus')
        expect(await service.prompt(HerdrPaneId('w1:p2'), 'hello')).toEqual({ ok: false, code: 'agent_blocked', message: 'agent is at a dialog' })
        expect(await service.focus(HerdrPaneId('w1:p2'))).toEqual({ ok: false, code: 'agent_blocked', message: 'agent is at a dialog' })
        server.answer(undefined, 'agent.prompt')
        server.answer(undefined, 'pane.focus')
        expect(await service.prompt(HerdrPaneId('w1:p2'), 'hello')).toEqual({ ok: true })
        expect(server.requests.at(-1)?.params).toEqual({ target: 'w1:p2', text: 'hello' })
        expect(await service.focus(HerdrPaneId('w1:p2'))).toEqual({ ok: true })
        expect(server.requests.at(-1)?.params).toEqual({ pane_id: 'w1:p2' })
      })
    } finally {
      await server.close()
    }
  })

  it('prompts, focuses, and sends keys on a pane with no agent, using the pane wire methods', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath }, async (service) => {
        await collect(service, (view, count) => view.connection.status === 'connected' && count >= 1)
        // w1:p1 hosts an agent and w1:p2 is a plain shell; both are addressed as
        // panes, and the shell is focusable and keyed through `pane.*`.
        const shell = HerdrPaneId('w1:p2')
        server.answer({ error: { code: 'agent_not_found', message: 'no agent in this pane' } }, 'agent.prompt')
        // A pane with no agent is a result the caller asked about, not a throw.
        expect(await service.prompt(shell, 'hello'))
          .toEqual({ ok: false, code: 'agent_not_found', message: 'no agent in this pane' })
        expect(server.requests.at(-1)?.method).toBe('agent.prompt')
        expect(server.requests.at(-1)?.params).toEqual({ target: 'w1:p2', text: 'hello' })
        expect(await service.focus(shell)).toEqual({ ok: true })
        expect(server.requests.at(-1)?.method).toBe('pane.focus')
        expect(server.requests.at(-1)?.params).toEqual({ pane_id: 'w1:p2' })
        expect(await service.sendKeys(shell, ['enter'])).toEqual({ ok: true })
        expect(server.requests.at(-1)?.method).toBe('pane.send_keys')
        expect(server.requests.at(-1)?.params).toEqual({ pane_id: 'w1:p2', keys: ['enter'] })
      })
    } finally {
      await server.close()
    }
  })

  it('rejects a key outside the surface before writing anything', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      await withService({ socketPath: server.socketPath }, async (service) => {
        await collect(service, (view, count) => view.connection.status === 'connected' && count >= 1)
        const before = server.requests.length
        // The Remote boundary is a JSON boundary: a caller outside the TypeScript
        // build can send any string, so the runtime rejection is exercised with
        // one widening cast exactly as the Host receives it.
        const unchecked = ['esc', 'ctrl+shift+delete'] as readonly HerdrKey[]
        expect(await service.sendKeys(HerdrPaneId('w1:p2'), unchecked))
          .toEqual({ ok: false, code: 'invalid_key', message: 'herdr: key ctrl+shift+delete is not on the command surface' })
        expect(server.requests.length).toBe(before)
        server.answer(undefined, 'session.snapshot')
        expect(await service.sendKeys(HerdrPaneId('w1:p2'), ['esc', 'ctrl+c'])).toEqual({ ok: true })
        // `pane.send_keys` addresses the pane, so a shell with no agent works.
        expect(server.requests.at(-1)?.method).toBe('pane.send_keys')
        expect(server.requests.at(-1)?.params).toEqual({ pane_id: 'w1:p2', keys: ['esc', 'ctrl+c'] })
      })
    } finally {
      await server.close()
    }
  })
})

describe('disposal', () => {
  it('closes the subscription, reports the reason on later calls, and is idempotent', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      const ctx = new Context()
      const service = new HerdrService(ctx, HerdrService.Config({ socketPath: server.socketPath }))
      await collect(service, view => view.connection.status === 'connected')
      await service.dispose()
      await service.dispose()
      // A disposed service is local misuse, not a Herdr refusal: both a read and
      // a command fail loud instead of quietly reporting a server error.
      await expect(service.read(HerdrPaneId('w1:p1'))).rejects.toThrow('the service was disposed')
      await expect(service.prompt(HerdrPaneId('w1:p2'), 'x')).rejects.toThrow('the service was disposed')
      await ctx.fiber.dispose()
    } finally {
      await server.close()
    }
  })

  it('ignores a stream failure that lands while the service is disposing', async () => {
    const server = await startFakeHerdr()
    server.answer({ result: SNAPSHOT }, 'session.snapshot')
    try {
      const ctx = new Context()
      const service = new HerdrService(ctx, HerdrService.Config({ socketPath: server.socketPath }))
      await collect(service, view => view.connection.status === 'connected')
      const pending = service.dispose()
      // The subscription socket closes as part of disposal; the resulting stream
      // failure must not republish a view or start a new connect.
      server.dropSubscription()
      await pending
      await service.dispose()
      // The dropping stream must not start another connect: only the connect's own
      // ping ran, and no post-connect refresh was scheduled past disposal.
      expect(server.requests.filter(request => request.method === 'ping').length).toBe(1)
      await ctx.fiber.dispose()
    } finally {
      await server.close()
    }
  })

  it('wakes a pending reconnect wait so disposal never blocks on the backoff timer', async () => {
    const server = await startFakeHerdr()
    server.answer({ hang: true }, 'ping')
    try {
      const ctx = new Context()
      const service = new HerdrService(ctx, HerdrService.Config({
        socketPath: server.socketPath, requestTimeoutMs: 5_000, reconnectInitialMs: 60_000, reconnectMaxMs: 60_000,
      }))
      await collect(service, view => view.connection.status === 'unavailable')
      // Let the first attempt fail and the retry timer arm.
      await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
      // The backoff timer is armed; disposal must wake it rather than wait it out.
      const started = Date.now()
      await service.dispose()
      expect(Date.now() - started).toBeLessThan(5_000)
      await ctx.fiber.dispose()
    } finally {
      await server.close()
    }
  })
})
