/**
 * One long-lived external ACP coding agent bound to one DSH Session: its process, connection,
 * remote session, and the per-turn translation of ACP updates into DSH stream chunks.
 * @module @deepseek-ai/dsh-experimental-llm-acp/developer
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
  type ContentBlock as AcpContentBlock,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'
import { disposeAcpChild } from '@deepseek-ai/dsh-subagent-acp'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Fixed answer to the external agent's permission prompts. */
export type PermissionPolicy = 'allow' | 'reject'

/** Resolved launch facts for one external developer process. */
export interface DeveloperSpec {
  /** Executable that speaks ACP on stdio. */
  readonly command: string
  /** Arguments passed to {@link command}. */
  readonly args: readonly string[]
  /** Extra environment merged over the subprocess seam's scrubbed parent env. */
  readonly env: Record<string, string>
  /** Absolute process cwd and ACP session cwd. */
  readonly cwd: string
  /** ACP auth method id to call `authenticate` with before opening the session. */
  readonly authMethod?: string | undefined
  /** Value or name of the session's `model` config option to select after opening the session. */
  readonly model?: string | undefined
  /** Permission auto-answer policy. */
  readonly permission: PermissionPolicy
  /** Stdin-EOF grace before termination on dispose. */
  readonly disposeEofGraceMs: number
  /** SIGTERM-to-SIGKILL grace. */
  readonly disposeGraceMs: number
  /** Subprocess seam spawn. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/**
 * Map an ACP stop reason to a DSH finish reason; unclean stops become errors.
 * @param reason - terminal reason from `session/prompt`.
 * @returns the DSH finish reason.
 */
export function finishReason(reason: StopReason): FinishReason {
  switch (reason) {
    case 'end_turn':
      return { kind: 'stop' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', failure: { message: 'external agent turn cancelled', code: 'ABORTED' } }
    case 'refusal':
      return { kind: 'error', failure: { message: 'external agent refused the request', code: 'REFUSAL' } }
    default:
      return { kind: 'error', failure: { message: `external agent stopped: ${reason}`, code: 'REMOTE_STOP' } }
  }
}

/** Most model values listed in a selection error. */
const LISTED_MODELS = 20

/**
 * Resolve a requested model against the session's `model` config option.
 * @param options - config options returned by `session/new`.
 * @param requested - option value or display name, matched exactly, then case-insensitively.
 * @returns the config id and value to select.
 */
export function selectModel(options: readonly SessionConfigOption[], requested: string): { configId: string; value: string } {
  const option = options.find(candidate => candidate.category === 'model' && candidate.type === 'select')
  if (option === undefined || option.type !== 'select') {
    throw new LlmError('the external harness offers no model selection over ACP; configure its model in the harness itself', 'UNSUPPORTED_OPTION')
  }
  const values: SessionConfigSelectOption[] = option.options.flatMap(entry => 'group' in entry ? entry.options : [entry])
  const lower = requested.toLowerCase()
  const match = values.find(value => value.value === requested)
    ?? values.find(value => value.value.toLowerCase() === lower || value.name.toLowerCase() === lower)
  if (match === undefined) {
    const listed = values.slice(0, LISTED_MODELS).map(value => value.value).join(', ')
    const more = values.length > LISTED_MODELS ? `, and ${values.length - LISTED_MODELS} more` : ''
    throw new LlmError(`unknown model "${requested}" for the external harness; available: ${listed}${more}`, 'UNKNOWN_MODEL')
  }
  return { configId: option.id, value: match.value }
}

/** Text of one ACP content block; non-text blocks contribute nothing. */
function contentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/** Buffers chunks pushed from ACP callbacks and assembles sequential text/reasoning blocks. */
class TurnStream {
  private readonly items: StreamChunk[] = []
  private wake: (() => void) | undefined
  private index = -1
  private kind: 'text' | 'reasoning' | undefined
  private text = ''

  /** Translate one ACP update; updates without model output are dropped. */
  update(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.push('text', contentText(update.content))
        return
      case 'agent_thought_chunk':
        this.push('reasoning', contentText(update.content))
        return
      case 'tool_call':
        this.push('reasoning', `\n[tool] ${update.title}\n`)
        return
      default:
        // Plans, tool progress, mode, and usage updates have no DSH block equivalent.
        return
    }
  }

  /** Close the open block and append the terminal finish chunk. */
  finish(reason: FinishReason): void {
    this.closeBlock()
    this.emit({ type: 'finish', reason })
  }

  /**
   * Yield buffered chunks until `done` settles, then the remainder.
   * @param done - the turn's prompt request.
   */
  async *drain(done: Promise<unknown>): AsyncGenerator<StreamChunk> {
    const turn = { settled: false }
    done.then(
      () => { turn.settled = true; this.wake?.() },
      () => { turn.settled = true; this.wake?.() },
    )
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (turn.settled) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }

  /** Remove and return chunks appended after {@link drain} stopped. */
  rest(): StreamChunk[] {
    return this.items.splice(0)
  }

  private push(kind: 'text' | 'reasoning', text: string): void {
    if (text === '') return
    if (this.kind !== kind) {
      this.closeBlock()
      this.index += 1
      this.kind = kind
      this.emit({ type: 'block-start', index: this.index, blockType: kind })
    }
    this.text += text
    this.emit(kind === 'text'
      ? { type: 'text-delta', index: this.index, text }
      : { type: 'reasoning-delta', index: this.index, text })
  }

  private closeBlock(): void {
    if (this.kind === undefined) return
    this.emit({ type: 'block-end', index: this.index, block: { type: this.kind, text: this.text } })
    this.kind = undefined
    this.text = ''
  }

  private emit(chunk: StreamChunk): void {
    this.items.push(chunk)
    this.wake?.()
  }
}

/** Mutable notification route shared by the connection callback and the active turn. */
interface UpdateRoute {
  current?: TurnStream | undefined
}

/** One external developer process and its single remote ACP session. */
export class AcpDeveloper {
  private active = false

  private constructor(
    private readonly child: SubprocessHandle,
    private readonly agent: ClientContext,
    private readonly sessionId: string,
    private readonly route: UpdateRoute,
    private readonly eofGraceMs: number,
  ) {}

  /**
   * Spawn the external agent, initialize ACP, and open one session in `spec.cwd`.
   * @param spec - resolved launch facts.
   * @param signal - startup cancellation.
   * @returns the ready developer; a startup failure reaps the process before rejecting.
   */
  static async start(spec: DeveloperSpec, signal: AbortSignal | undefined): Promise<AcpDeveloper> {
    const { command, args } = spec
    let child: SubprocessHandle
    try {
      child = spec.spawn({
        argv: [command, ...args],
        cwd: spec.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
        graceMs: spec.disposeGraceMs,
        env: spec.env,
      })
    } catch (error: unknown) {
      throw new LlmError(`external harness "${command}" failed to start`, 'TRANSPORT', { cause: error })
    }
    /* v8 ignore next 3 -- 'pipe' dispositions expose both streams by the seam contract. */
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new LlmError('subprocess implementation dropped a piped protocol stream', 'TRANSPORT')
    }
    const route: UpdateRoute = {}
    const app = createAcpClientApp({ name: 'deepseek-harness-llm-acp' })
      .onNotification(methods.client.session.update, ({ params }) => {
        route.current?.update(params.update)
        return Promise.resolve()
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const allow = spec.permission === 'allow'
          ? params.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
          : undefined
        return Promise.resolve(allow === undefined
          ? { outcome: { outcome: 'cancelled' as const } }
          : { outcome: { outcome: 'selected' as const, optionId: allow.optionId } })
      })
    const agent = app.connect(ndJsonStream(
      NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )).agent
    const stop = new AbortController()
    const startup = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal])
    try {
      startup.throwIfAborted()
      const interrupted = new Promise<never>((_, reject) => {
        startup.addEventListener('abort', () => { reject(new Error('external harness startup aborted')) }, { once: true })
        void child.done.then(
          (outcome) => { reject(new Error(`external harness exited during startup (exit code ${String(outcome.exitCode)})`)) },
          reject,
        )
      })
      const session = await Promise.race([
        (async () => {
          await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
          if (spec.authMethod !== undefined) await agent.request(methods.agent.authenticate, { methodId: spec.authMethod })
          const session = await agent.request(methods.agent.session.new, { cwd: spec.cwd, mcpServers: [] })
          if (spec.model !== undefined) {
            const selection = selectModel(session.configOptions ?? [], spec.model)
            await agent.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, ...selection })
          }
          return session
        })(),
        interrupted,
      ])
      return new AcpDeveloper(child, agent, session.sessionId, route, spec.disposeEofGraceMs)
    } catch (error: unknown) {
      try {
        await disposeAcpChild(child, spec.disposeEofGraceMs)
      } catch (cleanupError: unknown) {
        /* v8 ignore next 2 -- teardown failure needs a process that survives SIGKILL. */
        throw new AggregateError([error, cleanupError], `external harness "${command}" failed ACP startup and teardown`)
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `external harness "${command}" failed ACP startup`,
        signal?.aborted === true ? 'ABORTED' : 'TRANSPORT',
        { cause: error },
      )
    } finally {
      stop.abort()
    }
  }

  /**
   * Run one prompt turn and stream its output as DSH chunks ending in `finish`.
   * @param text - complete prompt text for this turn.
   * @param signal - cancellation; sends `session/cancel`, and the agent's `cancelled` stop finishes `aborted`.
   * @returns the chunk stream.
   */
  async *prompt(text: string, signal: AbortSignal | undefined): AsyncGenerator<StreamChunk> {
    if (this.active) throw new LlmError('external developer already has a running turn', 'CONFLICT')
    this.active = true
    const stream = new TurnStream()
    this.route.current = stream
    const onAbort = (): void => {
      this.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId }).catch(
        /* v8 ignore next 3 -- the notification only fails after the process closed its pipe. */
        () => {
          // The process may already be gone; the pending prompt settles either way.
        },
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const turn = this.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
      yield* stream.drain(turn)
      let stopReason: StopReason
      try {
        stopReason = (await turn).stopReason
      } catch (error: unknown) {
        throw new LlmError(
          signal?.aborted === true ? 'external agent turn aborted' : 'external agent turn failed',
          signal?.aborted === true ? 'ABORTED' : 'TRANSPORT',
          { cause: error },
        )
      }
      stream.finish(finishReason(stopReason))
      yield* stream.rest()
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.route.current = undefined
      this.active = false
    }
  }

  /** Close stdin and escalate to termination until the process range exits. */
  async dispose(): Promise<void> {
    await disposeAcpChild(this.child, this.eofGraceMs)
  }
}
