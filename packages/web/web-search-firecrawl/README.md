---
description: "The Firecrawl-backed search provider for ctx.web: how deployments mount Firecrawl web search with query-relevant snippets."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-firecrawl

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-firecrawl`, the harness searches the web through Firecrawl and gets results whose snippets are query-relevant passages from each page. Choose it when a deployment has a Firecrawl API key. Firecrawl search returns no generated answer, so results carry no `content` — only citeable sources. A result with no non-blank description is dropped, so a call can return fewer sources than requested. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `firecrawl` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: firecrawl`.

### When to choose it

Choose this backend when a deployment holds a Firecrawl API key and wants search snippets drawn from the matching pages. The provider is unavailable — and every search call fails with a structured error — when the key is empty, the endpoint base does not parse, or `limit` is not a positive integer.

### Minimal configuration

Load the web service and the provider; the API key falls back to `$FIRECRAWL_API_KEY` from the launch environment.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: firecrawl
- name: '@deepseek-ai/dsh-web-search-firecrawl'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `$FIRECRAWL_API_KEY` | Firecrawl API key; empty or absent makes the provider unavailable |
| `baseURL` | `https://api.firecrawl.dev` | API base; `/v2/search` is appended. An unparseable value makes the provider unavailable |
| `limit` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-firecrawl) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each entry of Firecrawl's `data.web[]` maps to a `WebSearchSource`: `url`, `title`, and the trimmed `description` as `snippet`. Firecrawl fills `description` with query-relevant passages when it can and with the page's own description otherwise; an entry with neither is dropped. A request's `maxResults` wins over the configured `limit` and is sent as Firecrawl's `limit` — the final bound is enforced by the service, which truncates and flags.

### Failures and recovery

Provider failures — HTTP errors such as exhausted credits or rate limits, network failures, unparseable bodies — surface as `WebError` `WEB_PROVIDER_ERROR` with Firecrawl's own message when its error body has one; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `FirecrawlSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Firecrawl wire types: `FirecrawlSearchResponse`, `FirecrawlWebResult`, `FirecrawlError` |

### Request and mapping flow

`search()` posts the query and optional limit to `{baseURL}/v2/search` with bearer auth and `redirect: 'error'`. The parsed `data.web[]` entries are mapped one by one and snippet-less entries dropped. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`. Firecrawl's news and image result groups are not requested.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md) — the search request/result vocabulary and error codes.
- [Web package map](../README.md) — the package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [dsh-web-search-exa](../web-search-exa/README.md) — the Exa provider this package mirrors.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, and description snippets or its exact `Firecrawl search aborted`, `Firecrawl search request failed: <error>`, and `Firecrawl returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web results only** — Firecrawl's news, image, category, location, and time filters and inline page scraping are not exposed; they wait on provider-neutral service fields.
- **A result with no description is dropped** — fewer sources than requested can return.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
