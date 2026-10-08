---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-team-member-model

[English](2026-10-08-team-member-model.md) | 中文

## 概述

为持久化的 Agent Teams 成员记录新增可选的 model 字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-team-member-model
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "0bff5e9256cf33b10e27a092105d23885a2f68bbe449ed1a68df551d449d619b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，并像以前一样显示 Lead 的模型。只有当 spawn_teammate 请求了模型路由（例如外部编码智能体队友）时，名册才写入该字段；队友未加载时，list_agents 优先显示该字段而不是 Lead 的模型。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team：110 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
