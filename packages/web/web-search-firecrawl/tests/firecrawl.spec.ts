import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as firecrawlPlugin from '@deepseek-ai/dsh-web-search-firecrawl'
import { FIRECRAWL_PROVIDER_ID, FirecrawlSearchProvider } from '@deepseek-ai/dsh-web-search-firecrawl'
import { mapFirecrawlResponse, mapFirecrawlResult } from '../src/provider.ts'

const options = { apiKey: 'fc-key', baseURL: 'https://api.firecrawl.test' }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function abortingBody(status: number): Response {
  return Object.assign(new Response('x', { status }), {
    json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
  })
}

function stubFetch(response: () => Promise<Response>) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => response())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Firecrawl result mapping', () => {
  it('maps a result and trims its description into the snippet', () => {
    expect(mapFirecrawlResult({ url: 'https://a.test', title: 'A', description: ' passage ' }))
      .toEqual({ url: 'https://a.test', title: 'A', snippet: 'passage' })
  })

  it('drops results without a usable description and omits empty titles', () => {
    expect(mapFirecrawlResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapFirecrawlResult({ url: 'https://a.test', description: '  ' })).toBeUndefined()
    expect(mapFirecrawlResult({ url: 'https://a.test', title: null, description: 'x' })).toEqual({ url: 'https://a.test', snippet: 'x' })
    expect(mapFirecrawlResult({ url: 'https://a.test', title: '', description: 'x' })).toEqual({ url: 'https://a.test', snippet: 'x' })
  })

  it('maps a response and tolerates missing data', () => {
    expect(mapFirecrawlResponse({ data: { web: [{ url: 'https://a.test', description: 'one' }, { url: 'https://b.test' }] } }))
      .toEqual({ sources: [{ url: 'https://a.test', snippet: 'one' }], truncated: false })
    expect(mapFirecrawlResponse({}).sources).toEqual([])
    expect(mapFirecrawlResponse({ data: {} }).sources).toEqual([])
  })
})

describe('FirecrawlSearchProvider', () => {
  it('is available only with a key, a parseable base URL, and a positive integer limit', () => {
    expect(new FirecrawlSearchProvider(options).available()).toBe(true)
    expect(new FirecrawlSearchProvider({ ...options, apiKey: '' }).available()).toBe(false)
    expect(new FirecrawlSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
    expect(new FirecrawlSearchProvider({ ...options, limit: 0 }).available()).toBe(false)
    expect(new FirecrawlSearchProvider({ ...options, limit: 1.5 }).available()).toBe(false)
    expect(new FirecrawlSearchProvider({ ...options, limit: 3 }).available()).toBe(true)
  })

  it('posts the query and limit with bearer auth, request limits winning over the default', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: { web: [] } }))
    const signal = new AbortController().signal
    await new FirecrawlSearchProvider({ ...options, limit: 7 }).search({ query: 'q', maxResults: 2 }, signal)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.firecrawl.test/v2/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fc-key')
    expect(JSON.parse(init?.body as string)).toEqual({ query: 'q', limit: 2 })

    await new FirecrawlSearchProvider({ ...options, limit: 7 }).search({ query: 'q' })
    expect(JSON.parse(fetchMock.mock.calls[1]![1]?.body as string)).toEqual({ query: 'q', limit: 7 })
    await new FirecrawlSearchProvider(options).search({ query: 'q' })
    expect(JSON.parse(fetchMock.mock.calls[2]![1]?.body as string)).toEqual({ query: 'q' })
  })

  it('maps HTTP errors to WEB_PROVIDER_ERROR with the best available message', async () => {
    const provider = new FirecrawlSearchProvider(options)
    stubFetch(async () => jsonResponse({ error: 'Insufficient credits' }, { status: 402 }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Insufficient credits' }))
    stubFetch(async () => jsonResponse({ message: 'rate limited' }, { status: 429 }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow('rate limited')
    stubFetch(async () => jsonResponse({}, { status: 500 }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow('Firecrawl API error (HTTP 500)')
    stubFetch(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow('Firecrawl API error (HTTP 502)')
  })

  it('maps network failures, aborts, and unreadable bodies', async () => {
    const provider = new FirecrawlSearchProvider(options)
    stubFetch(async () => { throw new TypeError('network down') })
    await expect(provider.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    stubFetch(async () => { throw new DOMException('aborted', 'AbortError') })
    await expect(provider.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    stubFetch(async () => new Response('not json', { status: 200 }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    stubFetch(async () => abortingBody(200))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    stubFetch(async () => abortingBody(500))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-firecrawl plugin', () => {
  it('registers into ctx.web, threads config, and unregisters with its fiber', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: { web: [{ url: 'https://a.test', description: 'hit' }] } }))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: FIRECRAWL_PROVIDER_ID })
    const fiber = await ctx.plugin(firecrawlPlugin, { apiKey: 'fc-key', baseURL: 'https://api.firecrawl.test', limit: 4 })
    await expect(ctx.web.search({ query: 'q' })).resolves.toEqual({ sources: [{ url: 'https://a.test', snippet: 'hit' }], truncated: false })
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({ query: 'q', limit: 4 })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('falls back to $FIRECRAWL_API_KEY and the public API, and is unavailable without a key', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: { web: [] } }))
    vi.stubEnv('FIRECRAWL_API_KEY', 'env-key')
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: FIRECRAWL_PROVIDER_ID })
    const fiber = await ctx.plugin(firecrawlPlugin, {})
    await ctx.web.search({ query: 'q' })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.firecrawl.dev/v2/search')
    await fiber.dispose()

    vi.stubEnv('FIRECRAWL_API_KEY', undefined)
    await ctx.plugin(firecrawlPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in firecrawlPlugin).toBe(false)
  })
})
