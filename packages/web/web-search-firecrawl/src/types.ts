/**
 * Wire types for the Firecrawl search API (`POST https://api.firecrawl.dev/v2/search`). Types
 * only — no runtime code. Web results arrive in `data.web[]`; each carries a URL, an optional
 * title, and a `description` that holds query-relevant page passages when Firecrawl can
 * generate them and the page's own description otherwise.
 *
 * @module @deepseek-ai/dsh-web-search-firecrawl/types
 */

/** Request body sent to Firecrawl's search endpoint. */
export interface FirecrawlSearchRequest {
  query: string
  /** Firecrawl's result-count control; the seam still enforces the bound on return. */
  limit?: number
}

/** One entry of Firecrawl's `data.web[]`. */
export interface FirecrawlWebResult {
  url: string
  title?: string | null
  description?: string | null
}

/** Firecrawl's search response envelope. */
export interface FirecrawlSearchResponse {
  success?: boolean
  data?: { web?: FirecrawlWebResult[] }
}

/** Firecrawl's error response envelope (best-effort; fields vary by failure). */
export interface FirecrawlError {
  error?: string
  message?: string
}
