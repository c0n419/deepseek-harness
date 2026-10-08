---
description: "ctx.web 的 Firecrawl 搜索提供方：部署如何挂载 Firecrawl 网页搜索并获得与查询相关的摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-firecrawl

[English](README.md) | 中文

## 概述

借助 `dsh-web-search-firecrawl`，harness 通过 Firecrawl 搜索网页，结果的摘要是各页面中与查询相关的段落。当部署拥有 Firecrawl API key 时选择它。Firecrawl 搜索不返回生成的答案，因此结果不带 `content`——只有可引用的来源。没有非空描述的结果会被丢弃，因此一次调用返回的来源可能少于请求数量。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在已经加载 web 服务的组合中挂载此提供方；它注册为 `firecrawl` 搜索提供方，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动选用它——也可以用 `searchProvider: firecrawl` 固定它。

### 何时选择

当部署持有 Firecrawl API key，并希望搜索摘要取自匹配页面时选择此后端。当 key 为空、端点基址无法解析，或 `limit` 不是正整数时，提供方不可用——每次搜索调用都会以结构化错误失败。

### 最小配置

加载 web 服务和此提供方；API key 回退到启动环境中的 `$FIRECRAWL_API_KEY`。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: firecrawl
- name: '@deepseek-ai/dsh-web-search-firecrawl'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$FIRECRAWL_API_KEY` | Firecrawl API key；为空或缺失时提供方不可用 |
| `baseURL` | `https://api.firecrawl.dev` | API 基址；会追加 `/v2/search`。无法解析的值会使提供方不可用 |
| `limit` | （未设置） | 请求未携带 `maxResults` 时的默认结果数；必须是正整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-firecrawl)是所有可接受字段及其 JSDoc 的完整来源。

### 搜索返回什么

Firecrawl `data.web[]` 的每个条目映射为一个 `WebSearchSource`：`url`、`title`，以及去除首尾空白后作为 `snippet` 的 `description`。Firecrawl 能生成时会在 `description` 中填入与查询相关的段落，否则使用页面自身的描述；两者都没有的条目会被丢弃。请求的 `maxResults` 优先于配置的 `limit`，并作为 Firecrawl 的 `limit` 发送——最终上限由服务强制执行，服务会截断并标记。

### 失败与恢复

提供方失败——HTTP 错误（例如额度耗尽或速率限制）、网络失败、无法解析的响应体——表现为 `WebError` `WEB_PROVIDER_ERROR`；当 Firecrawl 的错误响应体带有消息时使用该消息。被中止的请求表现为 `WEB_ABORTED`。HTTP 重定向会在联系 `Location` 目标之前被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `FirecrawlSearchProvider`：请求发送、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Firecrawl 线上类型：`FirecrawlSearchResponse`、`FirecrawlWebResult`、`FirecrawlError` |

### 请求与映射流程

`search()` 以 bearer 认证和 `redirect: 'error'` 将查询和可选的 limit 发送到 `{baseURL}/v2/search`。解析后的 `data.web[]` 条目逐个映射，没有摘要的条目被丢弃。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其他情况变为 `WEB_PROVIDER_ERROR`。不会请求 Firecrawl 的新闻和图片结果组。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Web 子系统](../../../docs/subsystems/web.zh.md)——搜索请求/结果词汇和错误码。
- [Web 包地图](../README.zh.md)——包族及各自的角色。
- [dsh-web](../web/README.zh.md)——此提供方注册到的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——呈现此提供方来源的面向模型的 `web_search` 工具。
- [dsh-web-search-exa](../web-search-exa/README.zh.md)——此包所参照的 Exa 提供方。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`，它保留此提供方受 `maxResults` 限制的 URL、标题和描述摘要，或在使用方的错误包装下保留其确切的 `Firecrawl search aborted`、`Firecrawl search request failed: <error>` 和 `Firecrawl returned an unprocessable response body: <error>` 失败信息。

#### KV Cache 影响

没有直接失效；由上述使用方负责任何请求前缀的变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限网页结果**——Firecrawl 的新闻、图片、类别、地区和时间过滤以及内联页面抓取未开放；它们需要先有与提供方无关的服务字段。
- **没有描述的结果会被丢弃**——返回的来源可能少于请求数量。
- **中止分类基于错误形态**——只有名为 `AbortError` 的 `DOMException` 映射为 `WEB_ABORTED`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
