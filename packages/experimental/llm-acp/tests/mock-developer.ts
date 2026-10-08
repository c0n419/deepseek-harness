/**
 * Multi-turn mock ACP agent for the keyless `dsh-experimental-llm-acp` tests. It keeps one
 * session and answers every prompt with a thought, a tool call, a plan, empty and non-text chunks, and
 * `turn <n> in <cwd> [model <selected>] [auth <method>] [permission <outcome>]: <prompt text>`.
 * The model is chosen through the `model` config option (`fast-1`, or `slow-2` in group `big`).
 * Environment switches:
 *
 * - `MOCK_HANG=1` — each prompt waits for `session/cancel` and answers `cancelled`.
 * - `MOCK_PERMISSION=1` — each prompt first asks for permission and reports the outcome.
 * - `MOCK_NO_CONFIG=1` — `session/new` returns no config options.
 * - `MOCK_EXIT_ON_PROMPT=1` — the process exits while a prompt is running.
 * - `MOCK_EXIT_ON_CANCEL=1` — the process exits when it receives `session/cancel`.
 *
 * It imports no harness code.
 * @module @deepseek-ai/dsh-experimental-llm-acp/tests/mock-developer
 */

import { Readable, Writable } from 'node:stream'
import { agent as createAcpAgentApp, methods, ndJsonStream, PROTOCOL_VERSION, type SessionUpdate, type StopReason } from '@agentclientprotocol/sdk'

let turn = 0
let cwd = ''
let cancel: ((reason: StopReason) => void) | undefined
let model = ''
let auth = ''

createAcpAgentApp({ name: 'dsh-llm-acp-test-agent' })
  .onRequest(methods.agent.initialize, () => Promise.resolve({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {},
    authMethods: [{ id: 'mock-login', name: 'Mock login' }],
  }))
  .onRequest(methods.agent.authenticate, ({ params }) => {
    auth = ` auth ${params.methodId}`
    return Promise.resolve({})
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    cwd = params.cwd
    if (process.env.MOCK_NO_CONFIG === '1') return Promise.resolve({ sessionId: 'mock-session' })
    return Promise.resolve({
      sessionId: 'mock-session',
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'fast-1',
        options: [
          { group: 'small', name: 'Small', options: [{ value: 'fast-1', name: 'Fast One' }] },
          { group: 'big', name: 'Big', options: [{ value: 'slow-2', name: 'Slow Two' }] },
        ],
      }],
    })
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if ('value' in params && typeof params.value === 'string') model = ` model ${params.value}`
    return Promise.resolve({ configOptions: [] })
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    turn += 1
    const text = params.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    const update = (value: SessionUpdate) =>
      client.notify(methods.client.session.update, { sessionId: params.sessionId, update: value })
    let permission = ''
    if (process.env.MOCK_PERMISSION === '1') {
      const decision = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: `call-${turn}`, title: 'write file' },
        options: [
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        ],
      })
      permission = ` permission ${decision.outcome.outcome === 'selected' ? decision.outcome.optionId : 'cancelled'}`
    }
    await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'planning' } })
    await update({ sessionUpdate: 'tool_call', toolCallId: `call-${turn}`, title: 'edit file', kind: 'edit' })
    await update({ sessionUpdate: 'plan', entries: [{ content: 'edit', priority: 'medium', status: 'pending' }] })
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: 'file:///x', name: 'x' } })
    if (process.env.MOCK_EXIT_ON_PROMPT === '1') process.exit(7)
    if (process.env.MOCK_HANG === '1') {
      return { stopReason: await new Promise<StopReason>((resolve) => { cancel = resolve }) }
    }
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `turn ${turn} in ${cwd}${model}${auth}${permission}: ${text}` },
    })
    return { stopReason: 'end_turn' }
  })
  .onNotification(methods.agent.session.cancel, () => {
    if (process.env.MOCK_EXIT_ON_CANCEL === '1') process.exit(8)
    cancel?.('cancelled')
    return Promise.resolve()
  })
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))
