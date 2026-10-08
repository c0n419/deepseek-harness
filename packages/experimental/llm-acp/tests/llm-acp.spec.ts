import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'
import * as LlmAcp from '../src/index.ts'
import { parseModelId, turnPrompt } from '../src/index.ts'
import { AcpDeveloper, finishReason, selectModel, type DeveloperSpec } from '../src/developer.ts'

const mock = fileURLToPath(new URL('./mock-developer.ts', import.meta.url))
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-llm-acp-')))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function gitRepo(): string {
  const repo = tempDir()
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return repo
}

function harness(env: Record<string, string> = {}, authMethod?: string): LlmAcp.HarnessConfig {
  return { command: process.execPath, args: [mock], env, ...authMethod === undefined ? {} : { authMethod } }
}

interface Setup extends Context {
  unload(): Promise<void>
}

async function setup(cwd: string | undefined, config: Partial<LlmAcp.Config> = {}): Promise<Setup> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const agent = (id: string): Agent | undefined =>
    cwd === undefined ? undefined : ({ id, session: { header: { cwd } } }) as Partial<Agent> as Agent
  ctx.provide('agents', { get: agent } as Partial<Context['agents']> as Context['agents'])
  const fiber = await ctx.plugin(LlmAcp, {
    permission: 'allow',
    isolation: 'shared',
    harnesses: { mock: harness() },
    ...config,
  } as LlmAcp.Config)
  const unload = async (): Promise<void> => { await fiber.dispose() }
  cleanups.push(unload)
  return Object.assign(ctx, { unload })
}

function user(text: string): RequestMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function reply(text: string): RequestMessage {
  return createAssistantMessage({
    content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text }],
    source: { provider: 'acp', model: 'mock' },
  })
}

async function collect(stream: AsyncIterable<StreamChunk>, abortOn?: AbortController): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk.type === 'reasoning-delta') abortOn?.abort()
  }
  return chunks
}

function run(
  ctx: Context,
  options: Partial<GenerateOptions> & { messages: RequestMessage[] },
  abortOn?: AbortController,
): Promise<StreamChunk[]> {
  return collect(ctx.llm.stream({
    provider: 'acp',
    model: 'mock',
    sessionId: SessionId('s1'),
    ...abortOn === undefined ? {} : { signal: abortOn.signal },
    ...options,
  }), abortOn)
}

function finalText(chunks: readonly StreamChunk[]): string {
  return chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []).join('')
}

function spec(cwd: string, overrides: Partial<DeveloperSpec> = {}): DeveloperSpec {
  return {
    command: process.execPath,
    args: [mock],
    env: {},
    cwd,
    permission: 'allow',
    disposeEofGraceMs: 2_000,
    disposeGraceMs: 1_000,
    spawn: spawnSubprocess,
    ...overrides,
  }
}

describe('parseModelId', () => {
  it('splits the harness from a model that may contain slashes', () => {
    expect(parseModelId('claude')).toEqual({ harness: 'claude' })
    expect(parseModelId('opencode/anthropic/claude-sonnet')).toEqual({ harness: 'opencode', model: 'anthropic/claude-sonnet' })
  })
})

describe('turnPrompt', () => {
  it('sends only the input after the last assistant reply to a running session', () => {
    expect(turnPrompt([user('task'), reply('done'), user('next'), user('more')], false)).toBe('next\n\nmore')
  })

  it('prefixes a transcript when a new session must continue existing history', () => {
    expect(turnPrompt([user('task'), reply('done'), user('next')], true)).toBe(
      'Earlier conversation in this task, restored after a restart:\n\nRequest:\ntask\n\nYour reply:\ndone\n\n---\n\nnext',
    )
  })

  it('rejects a request with no new input', () => {
    expect(() => turnPrompt([user('task'), reply('done')], false)).toThrow('no new user input')
  })
})

describe('finishReason', () => {
  it('maps every ACP stop reason and treats unclean stops as errors', () => {
    expect(finishReason('end_turn')).toEqual({ kind: 'stop' })
    expect(finishReason('max_tokens')).toEqual({ kind: 'max-tokens' })
    expect(finishReason('cancelled')).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
    expect(finishReason('refusal')).toMatchObject({ kind: 'error', failure: { code: 'REFUSAL' } })
    expect(finishReason('max_turn_requests')).toMatchObject({ kind: 'error', failure: { code: 'REMOTE_STOP' } })
  })
})

describe('selectModel', () => {
  const flat = [{
    id: 'model',
    name: 'Model',
    category: 'model' as const,
    type: 'select' as const,
    currentValue: 'm0',
    options: Array.from({ length: 22 }, (_, i) => ({ value: `m${i}`, name: `Model ${i}` })),
  }]

  it('matches values exactly, then values or names without case', () => {
    expect(selectModel(flat, 'm3')).toEqual({ configId: 'model', value: 'm3' })
    expect(selectModel(flat, 'MODEL 4')).toEqual({ configId: 'model', value: 'm4' })
  })

  it('lists at most twenty values for an unknown model', () => {
    expect(() => selectModel(flat, 'x')).toThrow(/available: m0, .*m19, and 2 more$/u)
  })

  it('rejects agents without a model option', () => {
    expect(() => selectModel([], 'x')).toThrow('offers no model selection')
  })
})

describe('AcpDeveloper', () => {
  it('rejects a second concurrent turn', async () => {
    const developer = await AcpDeveloper.start(spec(tempDir(), { env: { MOCK_HANG: '1' } }), undefined)
    cleanups.push(() => developer.dispose())
    const controller = new AbortController()
    const first = developer.prompt('one', controller.signal)
    await first.next()
    await expect(developer.prompt('two', undefined).next()).rejects.toMatchObject({ code: 'CONFLICT' })
    controller.abort()
    await collect(first)
  })

  it('reports an aborted startup', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(AcpDeveloper.start(spec(tempDir()), controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('reports a process that exits during startup', async () => {
    await expect(AcpDeveloper.start(spec(tempDir(), { args: ['-e', 'process.exit(3)'] }), undefined))
      .rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('reports a command that cannot start', async () => {
    const spawn = (): never => { throw new Error('spawn refused') }
    await expect(AcpDeveloper.start(spec(tempDir(), { spawn }), undefined)).rejects.toMatchObject({ code: 'TRANSPORT' })
  })
})

describe('llm-acp adapter', () => {
  it('keeps one external session across turns and streams reasoning then text', async () => {
    const cwd = tempDir()
    const ctx = await setup(cwd)
    const first = await run(ctx, { messages: [user('build it')] })
    expect(first.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'reasoning-delta', 'block-end',
      'block-start', 'text-delta', 'block-end', 'finish',
    ])
    expect(first[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'planning\n[tool] edit file\n' } })
    expect(finalText(first)).toBe(`turn 1 in ${cwd}: build it`)
    expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    const second = await run(ctx, { messages: [user('build it'), reply(finalText(first)), user('now test it')] })
    expect(finalText(second)).toBe(`turn 2 in ${cwd}: now test it`)
  })

  it('advertises each harness as a model', async () => {
    const ctx = await setup(tempDir(), { harnesses: { mock: harness(), other: harness() } })
    expect((await ctx.llm.listModels('acp')).map(model => model.id)).toEqual(['mock', 'other'])
  })

  it('selects the requested model and restarts the agent in the same worktree when the model changes', async () => {
    const ctx = await setup(gitRepo(), { isolation: 'worktree', worktreeRoot: tempDir() })
    expect(finalText(await run(ctx, { model: 'mock/Slow Two', messages: [user('hi')] }))).toMatch(/model slow-2: hi$/u)
    const switched = await run(ctx, { model: 'mock/fast-1', messages: [user('hi'), reply('ok'), user('again')] })
    expect(finalText(switched)).toMatch(/^turn 1 in .*\/s1 model fast-1: Earlier conversation in this task/u)
  })

  it('fails the turn for a model the external agent does not offer', async () => {
    const ctx = await setup(tempDir())
    expect((await run(ctx, { model: 'mock/huge-9', messages: [user('hi')] })).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNKNOWN_MODEL', message: 'unknown model "huge-9" for the external harness; available: fast-1, slow-2' } },
    })
  })

  it('authenticates and answers permission prompts by policy', async () => {
    const env = { MOCK_PERMISSION: '1' }
    const allowed = await setup(tempDir(), { harnesses: { mock: harness(env, 'mock-login') } })
    expect(finalText(await run(allowed, { messages: [user('hi')] }))).toMatch(/auth mock-login permission yes: hi$/u)
    const rejected = await setup(tempDir(), { permission: 'reject', harnesses: { mock: harness(env) } })
    expect(finalText(await run(rejected, { messages: [user('hi')] }))).toMatch(/permission cancelled: hi$/u)
  })

  it('runs each Session in its own git worktree and branch', async () => {
    const repo = gitRepo()
    const root = tempDir()
    const ctx = await setup(repo, { isolation: 'worktree', worktreeRoot: root })
    expect(finalText(await run(ctx, { messages: [user('hi')] }))).toBe(`turn 1 in ${join(root, 's1')}: hi`)
    expect(execFileSync('git', ['-C', join(root, 's1'), 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('dsh-team/s1')
  })

  it('fails loudly with git\'s reason when worktree isolation runs outside a git repository', async () => {
    const ctx = await setup(tempDir(), { isolation: 'worktree', worktreeRoot: tempDir() })
    const end = (await run(ctx, { messages: [user('hi')] })).at(-1)
    expect(end).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'WORKTREE_FAILED' } } })
    expect(JSON.stringify(end)).toContain('not a git repository')
  })

  it('checks out a branch left behind by a removed worktree', async () => {
    const repo = gitRepo()
    const root = tempDir()
    const ctx = await setup(repo, { isolation: 'worktree', worktreeRoot: root })
    await run(ctx, { messages: [user('hi')] })
    ctx.emit('agent/disposed', { agent: { id: SessionId('s1') } as Partial<Agent> as Agent })
    await expect.poll(() => {
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', join(root, 's1')])
        return true
      } catch {
        // The released agent may still hold the directory open for a moment.
        return false
      }
    }).toBe(true)
    expect(finalText(await run(ctx, { messages: [user('hi'), reply('ok'), user('again')] }))).toContain(`in ${join(root, 's1')}`)
    expect(execFileSync('git', ['-C', join(root, 's1'), 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('dsh-team/s1')
  })

  it('cancels the remote turn when the request aborts', async () => {
    const ctx = await setup(tempDir(), { harnesses: { mock: harness({ MOCK_HANG: '1' }) } })
    expect((await run(ctx, { messages: [user('hi')] }, new AbortController())).at(-1))
      .toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('reports an agent that exits during a turn or on cancellation', async () => {
    const crashed = await setup(tempDir(), { harnesses: { mock: harness({ MOCK_EXIT_ON_PROMPT: '1' }) } })
    expect((await run(crashed, { messages: [user('hi')] })).at(-1))
      .toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } })
    const cancelled = await setup(tempDir(), { harnesses: { mock: harness({ MOCK_HANG: '1', MOCK_EXIT_ON_CANCEL: '1' }) } })
    expect((await run(cancelled, { messages: [user('hi')] }, new AbortController())).at(-1))
      .toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('rejects requests it cannot route to an external agent', async () => {
    const ctx = await setup(tempDir(), { harnesses: { mock: harness({ MOCK_NO_CONFIG: '1' }) } })
    expect((await run(ctx, { purpose: 'session-title', messages: [user('hi')] })).at(-1))
      .toMatchObject({ reason: { failure: { code: 'UNSUPPORTED_OPTION' } } })
    expect((await collect(ctx.llm.stream({ provider: 'acp', model: 'mock', messages: [user('hi')] }))).at(-1))
      .toMatchObject({ reason: { failure: { code: 'INVALID_REQUEST' } } })
    expect((await run(ctx, { model: 'nobody', messages: [user('hi')] })).at(-1))
      .toMatchObject({ reason: { failure: { code: 'UNKNOWN_MODEL' } } })
    const unselectable = (await run(ctx, { model: 'mock/fast-1', messages: [user('hi')] })).at(-1)
    expect(unselectable).toMatchObject({ reason: { failure: { code: 'UNSUPPORTED_OPTION' } } })
    expect(JSON.stringify(unselectable)).toContain('no model selection')
    const homeless = await setup(undefined)
    expect((await run(homeless, { messages: [user('hi')] })).at(-1))
      .toMatchObject({ reason: { failure: { code: 'INVALID_REQUEST' } } })
  })

  it('releases a Session agent with its Agent and the provider route with the plugin', async () => {
    const ctx = await setup(tempDir())
    ctx.emit('agent/disposed', { agent: { id: SessionId('never-started') } as Partial<Agent> as Agent })
    const failed = await setup(tempDir(), { harnesses: { mock: { command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} } } })
    await run(failed, { messages: [user('hi')] })
    failed.emit('agent/disposed', { agent: { id: SessionId('s1') } as Partial<Agent> as Agent })
    await run(ctx, { messages: [user('hi')] })
    ctx.emit('agent/disposed', { agent: { id: SessionId('s1') } as Partial<Agent> as Agent })
    await expect.poll(async () => finalText(await run(ctx, { messages: [user('again')] }))).toMatch(/^turn 1 /u)
    await ctx.unload()
    expect((await run(ctx, { messages: [user('hi')] })).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('validates its configuration at load', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const load = (config: Partial<LlmAcp.Config>) => () => {
      LlmAcp.apply(ctx, {
        provider: 'acp',
        permission: 'allow',
        isolation: 'shared',
        branchPrefix: 'b/',
        disposeEofGraceMs: 1,
        disposeGraceMs: 1,
        harnesses: {},
        ...config,
      })
    }
    expect(load({ worktreeRoot: 'relative' })).toThrow('worktreeRoot must be absolute')
    expect(load({ harnesses: { 'a/b': harness() } })).toThrow('must be non-empty and contain no "/"')
    expect(load({ harnesses: { a: { ...harness(), command: '' } } })).toThrow('has an empty command')
  })
})
