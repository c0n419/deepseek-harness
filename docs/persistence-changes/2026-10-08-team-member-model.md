---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-team-member-model

English | [中文](2026-10-08-team-member-model.zh.md)

## Summary

Adds an optional model to persisted Agent Teams member records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid and keep showing the Lead's model as before. The roster writes the field only when spawn_teammate requests a model route, such as an external coding-agent teammate, and list_agents prefers it over the Lead's model while the teammate is not loaded.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team: 110 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
