/**
 * LLM provider route whose "model" is an external ACP coding agent (Claude Code, Codex,
 * OpenCode, pi, omp, …). Each DSH Session that selects the route gets its own long-lived agent
 * process and remote ACP session, optionally in a dedicated git worktree, so a continuable
 * child Session can act as one independent developer.
 * @module @deepseek-ai/dsh-experimental-llm-acp
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS } from '@deepseek-ai/dsh-subagent-acp'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AcpDeveloper, type PermissionPolicy } from './developer.ts'

export const name = 'llm-acp'
export const inject = ['llm', 'subprocess', 'agents']

/** How to launch one external harness as an ACP agent. */
export interface HarnessConfig {
  /** Executable that speaks ACP on stdio (the harness itself or its ACP adapter). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /** Extra environment for the process, merged over the credential-scrubbed parent env. */
  env: Record<string, string>
  /** ACP auth method id passed to `authenticate` before each session, for agents that require the call. */
  authMethod?: string
}

/** Plugin configuration. */
export interface Config {
  /**
   * Provider route registered on `ctx.llm`. Model ids under it are `<harness>` or `<harness>/<model>`;
   * `<model>` selects a value of the agent's ACP `model` session config option.
   */
  provider: string
  /** External harnesses by name; the name is the model-id prefix. */
  harnesses: Record<string, HarnessConfig>
  /** Answer to every permission prompt: `allow` selects the first allow option, `reject` cancels. */
  permission: PermissionPolicy
  /** `worktree` runs each Session in its own git worktree and branch; `shared` uses the Session cwd. */
  isolation: 'worktree' | 'shared'
  /** Absolute directory holding per-Session worktrees; defaults to `~/.dsh/worktrees`. */
  worktreeRoot?: string
  /** Branch name prefix for per-Session worktrees. */
  branchPrefix: string
  /** Stdin-EOF grace (ms) before the process is terminated on dispose. */
  disposeEofGraceMs: number
  /** SIGTERM-to-SIGKILL grace (ms). */
  disposeGraceMs: number
}

const HarnessConfig: z<HarnessConfig> = z.object({
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  authMethod: z.string(),
})

export const Config: z<Config> = z.object({
  provider: z.string().default('acp'),
  harnesses: z.dict(HarnessConfig).default({}),
  permission: z.union(['allow', 'reject'] as const).required(),
  isolation: z.union(['worktree', 'shared'] as const).default('worktree'),
  worktreeRoot: z.string(),
  branchPrefix: z.string().default('dsh-team/'),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/** An ACP prompt cannot be replayed without repeating the external agent's side effects. */
const NO_RETRY: ResolvedRetryPolicy = {
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: [],
  initialDelayMs: 0,
  maxDelayMs: 0,
  jitterRatio: 0,
}

/**
 * Split a model id into harness name and optional harness-native model.
 * @param model - `<harness>` or `<harness>/<model>`; the model part may contain `/`.
 * @returns the harness name and model.
 */
export function parseModelId(model: string): { harness: string; model?: string } {
  const slash = model.indexOf('/')
  return slash < 0 ? { harness: model } : { harness: model.slice(0, slash), model: model.slice(slash + 1) }
}

/** Concatenate the text blocks of one request message. */
function messageText(message: RequestMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Build the prompt for one turn: user input after the last assistant message, preceded by a
 * transcript of the earlier conversation when the external session is new but the DSH
 * Session already has history (a process restart).
 * @param messages - the request history.
 * @param fresh - whether the remote session was just created.
 * @returns prompt text.
 */
export function turnPrompt(messages: readonly RequestMessage[], fresh: boolean): string {
  const lastAssistant = messages.findLastIndex(message => message.role === 'assistant')
  const input = messages.slice(lastAssistant + 1)
    .filter(message => message.role === 'user')
    .map(messageText)
    .filter(text => text !== '')
    .join('\n\n')
  if (input === '') throw new LlmError('no new user input for the external agent', 'INVALID_REQUEST')
  if (!fresh || lastAssistant < 0) return input
  // ponytail: the remote session is not persisted, so a restart replays a text transcript;
  // use ACP session/load once a session-id event is worth a durable type.
  const transcript = messages.slice(0, lastAssistant + 1)
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => `${message.role === 'user' ? 'Request' : 'Your reply'}:\n${messageText(message)}`)
    .join('\n\n')
  return `Earlier conversation in this task, restored after a restart:\n\n${transcript}\n\n---\n\n${input}`
}

/** One registered developer, keyed by Session id. */
interface Entry {
  readonly model: string
  readonly developer: Promise<AcpDeveloper>
}

/** LLM adapter that routes each Session's turns to its own external ACP agent. */
class AcpAdapter extends LlmAdapter {
  private readonly developers = new Map<SessionId, Entry>()

  constructor(private readonly ctx: Context, private readonly config: Config, private readonly worktreeRoot: string) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'External coding agents (ACP)' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return NO_RETRY
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(Object.keys(this.config.harnesses).map(id => ({ provider: this.config.provider, id, name: id })))
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.purpose !== undefined) {
      throw new LlmError(`external agents do not serve ${options.purpose} requests`, 'UNSUPPORTED_OPTION')
    }
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new LlmError('external agent requests need a Session id', 'INVALID_REQUEST')
    const id = sessionId as SessionId
    let entry = this.developers.get(id)
    let fresh = false
    if (entry !== undefined && entry.model !== options.model) {
      await this.release(id)
      entry = undefined
    }
    if (entry === undefined) {
      const developer = this.start(id, options.model, options.signal)
      entry = { model: options.model, developer }
      this.developers.set(id, entry)
      developer.catch(() => {
        // A model switch may already have replaced this entry with a newer start.
        /* v8 ignore next -- the replacement needs a failing start racing a model switch. */
        if (this.developers.get(id) === entry) this.developers.delete(id)
      })
      fresh = true
    }
    const developer = await entry.developer
    yield* developer.prompt(turnPrompt(options.messages, fresh), options.signal)
  }

  /**
   * Dispose the developer bound to one Session, if any.
   * @param id - Session id.
   */
  async release(id: SessionId): Promise<void> {
    const entry = this.developers.get(id)
    if (entry === undefined) return
    this.developers.delete(id)
    // A start that fails after this release reports its error to the request that made it.
    /* v8 ignore next -- needs a start to fail while its release is already waiting on it. */
    const developer = await entry.developer.catch(() => undefined)
    await developer?.dispose()
  }

  /** Dispose every developer. */
  async releaseAll(): Promise<void> {
    await Promise.allSettled([...this.developers.keys()].map(id => this.release(id)))
  }

  private async start(id: SessionId, modelId: string, signal: AbortSignal | undefined): Promise<AcpDeveloper> {
    const { harness: harnessName, model } = parseModelId(modelId)
    const harness = this.config.harnesses[harnessName]
    if (harness === undefined) throw new LlmError(`unknown external harness "${harnessName}"`, 'UNKNOWN_MODEL')
    const workspace = this.ctx.agents.get(id)?.session.header.cwd
    if (workspace === undefined) throw new LlmError('external agent Session has no working directory', 'INVALID_REQUEST')
    const cwd = this.config.isolation === 'worktree' ? await this.worktree(workspace, id, signal) : workspace
    return await AcpDeveloper.start({
      command: harness.command,
      args: harness.args,
      env: harness.env,
      cwd,
      authMethod: harness.authMethod,
      model,
      permission: this.config.permission,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
    }, signal)
  }

  /**
   * Create, or reuse after a restart, the Session's worktree on its own branch. A branch left
   * behind by a removed worktree is checked out again instead of being recreated.
   */
  private async worktree(workspace: string, id: SessionId, signal: AbortSignal | undefined): Promise<string> {
    const path = join(this.worktreeRoot, id)
    if (existsSync(path)) return path
    const branch = `${this.config.branchPrefix}${id}`
    const existing = await this.git(workspace, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], signal)
    const added = await this.git(workspace, existing.ok ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path], signal)
    if (!added.ok) {
      throw new LlmError(`git worktree add failed in ${workspace}: ${added.stderr}; worktree isolation needs a git repository`, 'WORKTREE_FAILED')
    }
    return path
  }

  /** Run one git command in the workspace and keep its error output. */
  private async git(workspace: string, args: readonly string[], signal: AbortSignal | undefined): Promise<{ ok: boolean; stderr: string }> {
    const child = this.ctx.subprocess.spawn({
      argv: ['git', '-C', workspace, ...args],
      cwd: workspace,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: this.config.disposeGraceMs,
      signal,
    })
    const outcome = await child.done
    /* v8 ignore next -- a collected stderr disposition always provides its reader. */
    const stderr = child.collected.stderr?.readFrom(0).text.trim() ?? ''
    return { ok: outcome.exitCode === 0, stderr }
  }
}

/**
 * Register the `acp` provider route and release each Session's process with its Agent.
 * @param ctx - plugin context with `llm`, `subprocess`, and `agents`.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const worktreeRoot = config.worktreeRoot ?? dshHomePath('worktrees')
  if (!isAbsolute(worktreeRoot)) throw new Error(`llm-acp: worktreeRoot must be absolute: ${worktreeRoot}`)
  for (const [harness, spec] of Object.entries(config.harnesses)) {
    if (harness === '' || harness.includes('/')) throw new Error(`llm-acp: harness name "${harness}" must be non-empty and contain no "/"`)
    if (spec.command === '') throw new Error(`llm-acp: harness "${harness}" has an empty command`)
  }
  const adapter = new AcpAdapter(ctx, config, worktreeRoot)
  ctx.effect(() => ctx.llm.registerAdapter([config.provider], adapter))
  ctx.on('agent/disposed', ({ agent }) => {
    adapter.release(agent.id).catch(
      /* v8 ignore next 3 -- release fails only when process teardown fails. */
      (error: unknown) => {
        ctx.logger.warn(`llm-acp: releasing the external agent of Session ${agent.id} failed: %o`, error)
      },
    )
  })
  ctx.effect(() => () => adapter.releaseAll())
}
