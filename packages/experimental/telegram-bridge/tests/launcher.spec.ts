import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { Launcher } from '../src/launcher.ts'
import type { TelegramClient } from '../src/telegram.ts'

interface Write {
  readonly method: string
  readonly params: Record<string, unknown>
}

const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function provide<K extends keyof Context & string>(ctx: Context, name: K, value: Partial<Context[K]>): void {
  ctx.provide(name, value as Context[K])
}

interface HarnessOptions {
  projectsDir?: string
  projects?: string[]
  presets?: string[] | null
  controller?: boolean
  registry?: boolean
}

function workspace(id: string, title: string): Workspace {
  return { id, title } as Partial<Workspace> as Workspace
}

function harness(options: HarnessOptions = {}) {
  const writes: Write[] = []
  const client = {
    enqueue: vi.fn(async (method: string, params: Record<string, unknown>) => {
      writes.push({ method, params })
      return { message_id: 9 }
    }),
  }
  const ctx = new Context()
  const created: string[] = []
  const registry = {
    list: () => (options.projects ?? ['alpha']).map(title => workspace(`ws-${title}`, title)),
    create: vi.fn(async (path: string) => {
      created.push(path)
      return workspace('ws-new', path.slice(path.lastIndexOf('/') + 1))
    }),
  }
  if (options.registry !== false) provide(ctx, 'workspaceRegistry', registry)
  if (options.presets !== null) {
    const ids = options.presets ?? ['standard', 'team']
    provide(ctx, 'agentPresets', { list: async () => [...ids.map(id => ({ id })), { id: 'broken', broken: 'missing plugin' }] })
  }
  const controller = {
    create: vi.fn(async (_request: unknown) => ({ sessionId: SessionId('session-1') })),
    prompt: vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({ accepted: true as const })),
  }
  if (options.controller !== false) provide(ctx, 'sessionController', controller as Partial<Context['sessionController']>)
  const launcher = new Launcher(ctx, client as Partial<TelegramClient> as TelegramClient, {
    chatId: -100,
    projectsDir: options.projectsDir,
    draftTtlMs: 60_000,
  })
  const buttons = (): string[] => {
    const markup = writes.at(-1)?.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }
    return markup.inline_keyboard.flat().map(button => button.callback_data.slice(3))
  }
  const last = (): string => String(writes.at(-1)?.params.text)
  return { launcher, writes, controller, registry, created, buttons, last }
}

async function projectsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tg-launcher-'))
  dirs.push(dir)
  return dir
}

describe('Launcher', () => {
  it('asks for a project and a mode, then starts the Session with the task', async () => {
    const { launcher, controller, buttons, last } = await Promise.resolve(harness({ projects: ['alpha', 'beta'] }))
    await expect(launcher.start(7, 'add <2FA>')).resolves.toBe('')
    expect(last()).toBe('🆕 <b>Yeni görev:</b> add &lt;2FA&gt;\nProje seçin:')
    const [, beta] = buttons()
    expect(buttons()).toHaveLength(2)
    await expect(launcher.press(7, beta!)).resolves.toBe(true)
    expect(last()).toContain('Proje: <b>beta</b>\nMod seçin:')
    await expect(launcher.press(7, `${beta!.split(':')[0]!}:m:9`)).resolves.toBe(false)
    const modes = buttons()
    expect(modes).toHaveLength(2)
    await expect(launcher.press(7, modes[1]!)).resolves.toBe(true)
    expect(controller.create).toHaveBeenCalledWith({ workspaceId: 'ws-beta', agentPreset: 'team' })
    expect(controller.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'add <2FA>' }] }), expect.any(AbortSignal))
    expect(last()).toContain('🚀 <b>beta</b> · Team içinde başlatıldı')
    await expect(launcher.press(7, modes[0]!)).resolves.toBe(false)
  })

  it('rejects empty tasks, missing projects, foreign, expired, and out-of-order presses', async () => {
    const empty = harness({ projects: [] })
    await expect(empty.launcher.start(7, '')).resolves.toBe('Kullanım: /yeni &lt;görev&gt;')
    await expect(empty.launcher.start(7, 'x')).resolves.toBe('Kayıtlı proje yok; önce Web arayüzünden bir proje ekleyin.')
    await expect(empty.launcher.name(7, 'demo')).resolves.toBeUndefined()

    const { launcher, buttons } = harness({ registry: false, projectsDir: '/nowhere' })
    await launcher.start(7, 'x')
    const [create] = buttons()
    const id = create!.split(':')[0]!
    await expect(launcher.press(8, create!)).resolves.toBe(false)
    await expect(launcher.press(7, `${id}:m:0`)).resolves.toBe(false)
    await expect(launcher.press(7, `${id}:p:0`)).resolves.toBe(false)
    await expect(launcher.press(7, 'unknown:p:0')).resolves.toBe(false)
    await expect(launcher.press(7, create!)).resolves.toBe(true)
    await expect(launcher.name(7, 'demo')).resolves.toBe('⚠️ Proje kaydı kullanılamıyor.')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    await expect(launcher.press(7, create!)).resolves.toBe(false)
    await expect(launcher.name(7, 'demo')).resolves.toBeUndefined()
  })

  it('creates a git project from a typed name and keeps only the latest draft waiting for one', async () => {
    const dir = await projectsDir()
    const { launcher, created, buttons, last, controller } = harness({ projectsDir: dir, presets: [] })
    await launcher.start(8, 'someone else')
    await launcher.start(7, 'first')
    const firstNew = buttons().at(-1)!
    await launcher.start(7, 'second')
    const secondNew = buttons().at(-1)!
    await expect(launcher.press(7, firstNew)).resolves.toBe(true)
    expect(last()).toContain(`Yeni projenin adını yazın; <code>${dir}</code> altında açılır.`)
    await expect(launcher.press(7, secondNew)).resolves.toBe(true)
    await expect(launcher.name(7, '../escape')).resolves.toContain('Geçersiz ad')
    await expect(launcher.name(7, 'demo')).resolves.toBe('')
    expect((await stat(join(dir, 'demo', '.git'))).isDirectory()).toBe(true)
    expect(created).toEqual([join(dir, 'demo')])
    expect(controller.create).toHaveBeenCalledWith({ workspaceId: 'ws-new' })
    expect(last()).toBe('🆕 <b>Yeni görev:</b> second\n🚀 <b>demo</b> içinde başlatıldı; konusu ilk turda açılır.')
    await expect(launcher.name(7, 'demo')).resolves.toBeUndefined()

    await launcher.start(7, 'third')
    await launcher.press(7, buttons().at(-1)!)
    await expect(launcher.name(7, 'demo')).resolves.toBe('')
    expect(created).toHaveLength(2)
  })

  it('reports project and Session failures', async () => {
    const dir = await projectsDir()
    const failing = harness({ projectsDir: dir, controller: false, presets: null })
    failing.registry.create.mockRejectedValueOnce(new Error('not a directory'))
    await failing.launcher.start(7, 'x')
    await failing.launcher.press(7, failing.buttons().at(-1)!)
    await expect(failing.launcher.name(7, 'demo')).resolves.toBe('⚠️ Proje açılamadı: not a directory')
    failing.registry.create.mockRejectedValueOnce('denied')
    await expect(failing.launcher.name(7, 'demo')).resolves.toBe('⚠️ Proje açılamadı: denied')
    await expect(failing.launcher.name(7, 'demo')).resolves.toBe('')
    expect(failing.last()).toContain('⚠️ <b>demo</b> başlatılamadı: oturum denetleyicisi kullanılamıyor')

    const rejected = harness()
    rejected.controller.prompt.mockRejectedValueOnce('busy')
    await rejected.launcher.start(7, 'x')
    await rejected.launcher.press(7, rejected.buttons()[0]!)
    await rejected.launcher.press(7, rejected.buttons()[0]!)
    expect(rejected.last()).toContain('⚠️ <b>alpha</b> · Standard başlatılamadı: busy')
  })
})
