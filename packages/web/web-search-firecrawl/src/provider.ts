/**
 * `FirecrawlSearchProvider`: a `WebSearchProvider` backed by the Firecrawl search API
 * (`POST /v2/search`). It maps each web result's `description` to `snippet`, drops entries
 * without one, and omits `content` because Firecrawl search returns no generated answer.
 * @module @deepseek-ai/dsh-web-search-firecrawl/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { FirecrawlError, FirecrawlSearchResponse, FirecrawlWebResult } from './types.ts'

/** Stable id this provider registers under. */
export const FIRECRAWL_PROVIDER_ID = 'firecrawl'

/** Default Firecrawl API base; `/v2/search` is the operation. */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface FirecrawlSearchProviderOptions {
  /** Firecrawl API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** API base; `/v2/search` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  limit?: number
}

/**
 * Map one Firecrawl web result to a normalized source, or `undefined` when it carries no
 * non-blank description to use as the snippet.
 * @param result - one entry of Firecrawl's `data.web[]`.
 * @returns the normalized source, or `undefined`.
 */
export function mapFirecrawlResult(result: FirecrawlWebResult): WebSearchSource | undefined {
  const snippet = result.description?.trim()
  if (snippet === undefined || snippet.length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
  }
}

/**
 * Map a Firecrawl response envelope to a normalized search result.
 * @param response - the parsed `POST /v2/search` response body.
 * @returns the normalized result; snippet-less entries are dropped.
 */
export function mapFirecrawlResponse(response: FirecrawlSearchResponse): WebSearchResult {
  const sources = (response.data?.web ?? [])
    .map(mapFirecrawlResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // The web service owns the final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The Firecrawl-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class FirecrawlSearchProvider implements WebSearchProvider {
  readonly id = FIRECRAWL_PROVIDER_ID

  constructor(private readonly options: FirecrawlSearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && URL.canParse(this.options.baseURL)
      && (this.options.limit === undefined || (Number.isInteger(this.options.limit) && this.options.limit > 0))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; either may be absent.
    const limit = request.maxResults ?? this.options.limit
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/v2/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ query: request.query, ...limit !== undefined ? { limit } : {} }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Firecrawl search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      let message = `Firecrawl API error (HTTP ${response.status})`
      try {
        const parsed = await response.json() as FirecrawlError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (isAbortError(error)) throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: error })
        // A non-JSON error body (normal for gateway 5xx/429s) keeps the status-line message.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as FirecrawlSearchResponse
      return mapFirecrawlResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Firecrawl returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
