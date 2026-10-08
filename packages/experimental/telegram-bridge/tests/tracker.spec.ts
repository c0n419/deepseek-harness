import { describe, expect, it } from 'vitest'
import { escapeHtml, SessionTracker } from '../src/tracker.ts'

const lead = { id: 'lead-1', cwd: '/home/u/thinkertrader-futures', agentPreset: 'standard' }

function tracker(webUrl?: string): SessionTracker {
  return new SessionTracker({ excerptChars: 40, webUrl })
}

function reply(text: string, usage = { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 }) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text }] }, usage } }
}

describe('SessionTracker', () => {
  it('names a root topic by mode, title, and project, and gives it a topic once a turn starts', () => {
    const t = tracker()
    t.observe(lead, { type: 'agent-preset/selected', data: { agentPreset: 'team' } })
    expect(t.isActive('lead-1')).toBe(false)
    t.observe(lead, { type: 'session/title', data: { title: 'Bot karlılık' } })
    t.observe(lead, { type: 'turn/start' })
    expect(t.isActive('lead-1')).toBe(true)
    expect(t.running('lead-1')).toBe(true)
    expect(t.topicName('lead-1')).toBe('[Team] Bot karlılık · thinkertrader-futures')
    expect(t.roots()).toEqual(['lead-1'])
    expect(t.takeDirty()).toEqual(['lead-1'])
    expect(t.takeDirty()).toEqual([])
    expect(tracker().topicName('unknown-session-id-1234')).toBe('[Oturum] unknown-session-')
    const custom = tracker()
    custom.observe({ id: 'c', agentPreset: 'my-mode' }, { type: 'turn/start' })
    expect(custom.topicName('c')).toBe('[my-mode] c')
  })

  it('folds teammates and subagents into their root card with usage totals', () => {
    const t = tracker('https://ows.example/')
    t.observe(lead, { type: 'request/header', data: { header: { config: { provider: 'ollama', model: 'deepseek' } } } })
    t.observe(lead, { type: 'turn/start' })
    t.observe(lead, { type: 'team/member', data: { member: { id: 'mate-1', name: 'reviewer', model: 'claude/opus', phase: 'active' } } })
    t.observe({ id: 'mate-1', parentSession: 'lead-1' }, { type: 'turn/start' })
    t.observe({ id: 'mate-1', parentSession: 'lead-1' }, reply('looks fine'))
    t.observe({ id: 'sub-1', parentSession: 'mate-1' }, { type: 'subagent/descriptor', data: { label: 'grep helper', agentModel: 'flash' } })
    t.observe({ id: 'sub-1', parentSession: 'mate-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    t.observe(lead, reply('done'))
    t.observe(lead, { type: 'compaction/start' })
    t.observe(lead, { type: 'team/member', data: { member: { name: 'no-id' } } })
    t.observe(lead, { type: 'unknown/event' })
    expect(t.rootOf('sub-1')).toBe('lead-1')
    expect(t.card('lead-1')).toBe([
      '<b>[Standard] lead-1 · thinkertrader-futures</b>',
      '🟢 Lead · deepseek',
      '  ├ 🟢 reviewer · claude/opus',
      '  ├ ✅ grep helper · flash',
      '📊 2 adım · girdi 2K (önbellek %90) · çıktı 100 · 1 sıkıştırma',
      '<a href="https://ows.example/">Web arayüzünde aç</a>',
    ].join('\n'))
  })

  it('formats large token counts and cards without usage or links', () => {
    const t = tracker()
    t.observe({ id: 'r' }, { type: 'turn/start' })
    expect(t.card('r')).toContain('girdi 0 (önbellek %0) · çıktı 0')
    t.observe({ id: 'r' }, reply('a', { inputTokens: 1_500_000, cacheReadTokens: 0, outputTokens: 2000 }))
    expect(t.card('r')).toContain('girdi 1.5M (önbellek %0) · çıktı 2K')
    t.observe({ id: 'r' }, { type: 'assistant/message', data: { message: {}, usage: { inputTokens: Number.NaN } } })
    expect(t.card('r')).toContain('3 adım'.replace('3', '2'))
  })

  it('notifies finished, failed, and stopped turns with escaped excerpts', () => {
    const t = tracker()
    t.observe(lead, { type: 'turn/start' })
    t.observe(lead, reply('Result <b>ok</b> & a very long tail that will be cut off here'))
    expect(t.observe(lead, { type: 'turn/end', data: { reason: { kind: 'completed' } } })).toEqual([{
      rootId: 'lead-1',
      loud: true,
      text: '✅ Tur bitti.\n<blockquote>Result &lt;b&gt;ok&lt;/b&gt; &amp; a very long tail tha…</blockquote>',
    }])
    expect(t.card('lead-1')).toContain('✅ Lead')
    expect(t.observe({ id: 'quiet' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })[0]?.text).toBe('✅ Tur bitti.')
    expect(t.observe(lead, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })).toEqual([{ rootId: 'lead-1', loud: false, text: '⏹ Tur durduruldu.' }])
    expect(t.card('lead-1')).toContain('⏹ Lead')
    expect(t.observe(lead, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } }))
      .toEqual([{ rootId: 'lead-1', loud: true, text: '❌ Tur hata ile bitti: boom' }])
    expect(t.card('lead-1')).toContain('❌ Lead')
    const child = { id: 'mate-2', parentSession: 'lead-1' }
    expect(t.observe(child, { type: 'turn/end', data: { reason: { kind: 'completed' } } })).toEqual([])
    expect(t.observe(child, { type: 'turn/end', data: { reason: { kind: 'error' } } })[0]?.text).toBe('❌ <b>mate-2</b> hata ile bitti: ')
  })

  it('notifies failed teammates and questions, leaving approvals to the bridge', () => {
    const t = tracker()
    expect(t.observe(lead, { type: 'team/member', data: { member: { id: 'm', name: 'dev', phase: 'failed', error: 'git worktree add failed' } } }))
      .toEqual([{ rootId: 'lead-1', loud: true, text: '❌ <b>dev</b> başlatılamadı: git worktree add failed' }])
    expect(t.observe(lead, { type: 'team/member', data: { member: { id: 'n', phase: 'failed' } } })[0]?.text).toBe('❌ <b>n</b> başlatılamadı: ')
    expect(t.observe(lead, { type: 'approval/asked', data: { toolName: 'bash' } })).toEqual([])
    expect(t.nameOf('m')).toBe('dev')
    expect(t.nameOf('never-seen-id')).toBe('never-se')
    const question = JSON.stringify({ questions: [{ question: 'Hangisi?' }] })
    expect(t.observe(lead, { type: 'tool/call', data: { name: 'ask_user_question', arguments: question } })[0]?.text)
      .toBe('❓ <b>lead-1</b> soru soruyor: Hangisi?')
    expect(t.observe(lead, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{oops' } })[0]?.text).toContain('{oops')
    expect(t.observe(lead, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{}' } })[0]?.text).toContain('{}')
    expect(t.observe(lead, { type: 'tool/call', data: { name: 'ask_user_question' } })[0]?.text).toBe('❓ <b>lead-1</b> soru soruyor: ')
    expect(t.observe(lead, { type: 'tool/call', data: { name: 'bash' } })).toEqual([])
    t.observe(lead, { type: 'session/title', data: {} })
    t.observe(lead, { type: 'agent-preset/selected', data: 7 })
  })

  it('keeps known values when later events omit them and marks idle members', () => {
    const t = tracker()
    t.observe(lead, { type: 'request/header', data: { header: { config: { model: 'm1' } } } })
    t.observe(lead, { type: 'request/header', data: {} })
    t.observe(lead, { type: 'turn/start' })
    t.observe(lead, { type: 'team/member', data: { member: { id: 'idle', name: 'waiting' } } })
    t.observe({ id: 's', parentSession: 'lead-1' }, { type: 'subagent/descriptor', data: { label: 'helper', agentModel: 'x' } })
    t.observe({ id: 's', parentSession: 'lead-1' }, { type: 'subagent/descriptor', data: {} })
    t.observe(lead, { type: 'assistant/message', data: { message: { content: [{ type: 'text' }] } } })
    const card = t.card('lead-1')
    expect(card).toContain('🟢 Lead · m1')
    expect(card).toContain('  ├ ⚪ waiting\n')
    expect(card).toContain('  ├ ⚪ helper · x')
  })

  it('stops at parent cycles instead of looping', () => {
    const t = tracker()
    t.observe({ id: 'a', parentSession: 'b' }, { type: 'turn/start' })
    t.observe({ id: 'b', parentSession: 'a' }, { type: 'turn/start' })
    expect(['a', 'b']).toContain(t.rootOf('a'))
  })
})

describe('escapeHtml', () => {
  it('escapes the characters Telegram HTML reserves', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;')
  })
})
