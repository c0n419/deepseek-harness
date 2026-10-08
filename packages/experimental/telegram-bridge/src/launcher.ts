/**
 * Starting Sessions from Telegram: `/yeni <task>` asks for a project and a mode with inline
 * buttons, optionally creating a new git project under the configured projects directory, then
 * creates the Session and queues the task as its first prompt.
 * @module @deepseek-ai/dsh-experimental-telegram-bridge/launcher
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { TelegramClient } from './telegram.ts'
import { escapeHtml, modeLabel } from './tracker.ts'

/** Launcher settings taken from the bridge configuration. */
export interface LauncherOptions {
  /** Forum group the launcher writes to. */
  readonly chatId: number
  /** Directory that holds new projects; without it the launcher offers only registered projects. */
  readonly projectsDir?: string | undefined
  /** Milliseconds an unfinished `/yeni` stays answerable. */
  readonly draftTtlMs: number
}

type Button = { readonly text: string; readonly callback_data: string }
type Project = { readonly id: WorkspaceId; readonly title: string }

interface Draft {
  readonly userId: number
  readonly task: string
  readonly createdAt: number
  readonly messageId: number
  readonly projects: readonly Project[]
  /** Chosen project with the modes offered for it. */
  chosen?: { readonly project: Project; readonly modes: readonly AgentPreset[] }
  awaitingName: boolean
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const run = promisify(execFile)

/** Interactive `/yeni` drafts, keyed by a short id carried in button callback data. */
export class Launcher {
  private readonly drafts = new Map<string, Draft>()

  constructor(
    private readonly ctx: Context,
    private readonly client: TelegramClient,
    private readonly options: LauncherOptions,
  ) {}

  /**
   * Begin a draft for `task` by asking for its project.
   * @param userId - Telegram user who sent `/yeni`.
   * @param task - first prompt of the new Session.
   * @returns a reply for the caller to send, or `''` when the launcher already replied.
   */
  async start(userId: number, task: string): Promise<string> {
    if (task === '') return 'Kullanım: /yeni &lt;görev&gt;'
    const projects = (this.ctx.get('workspaceRegistry')?.list() ?? []).map(({ id, title }) => ({ id, title }))
    if (projects.length === 0 && this.options.projectsDir === undefined) {
      return 'Kayıtlı proje yok; önce Web arayüzünden bir proje ekleyin.'
    }
    const id = randomUUID().slice(0, 8)
    const rows: Button[][] = projects.map((project, index) => [{ text: project.title, callback_data: `nw:${id}:p:${String(index)}` }])
    if (this.options.projectsDir !== undefined) rows.push([{ text: '➕ Yeni proje', callback_data: `nw:${id}:new` }])
    const message = await this.client.enqueue<{ message_id: number }>('sendMessage', {
      chat_id: this.options.chatId,
      text: `${this.heading(task)}\nProje seçin:`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    })
    this.drafts.set(id, { userId, task, createdAt: Date.now(), messageId: message.message_id, projects, awaitingName: false })
    return ''
  }

  /**
   * Apply one `nw:` button press.
   * @param userId - Telegram user who pressed the button.
   * @param data - callback data after the `nw:` prefix.
   * @returns whether the press matched a live draft of that user.
   */
  async press(userId: number, data: string): Promise<boolean> {
    const [id = '', action, index] = data.split(':')
    const draft = this.live(id)
    if (draft?.userId !== userId) return false
    if (action === 'new' && this.options.projectsDir !== undefined) {
      for (const other of this.drafts.values()) if (other.userId === userId) other.awaitingName = false
      draft.awaitingName = true
      const where = escapeHtml(this.options.projectsDir)
      await this.edit(draft, `${this.heading(draft.task)}\nYeni projenin adını yazın; <code>${where}</code> altında açılır.`)
      return true
    }
    const project = action === 'p' ? draft.projects[Number(index)] : undefined
    if (project !== undefined) {
      await this.askMode(id, draft, project)
      return true
    }
    const chosen = draft.chosen
    const mode = action === 'm' ? chosen?.modes[Number(index)] : undefined
    if (chosen === undefined || mode === undefined) return false
    this.drafts.delete(id)
    await this.launch(draft, chosen.project, mode.id)
    return true
  }

  /**
   * Take a plain message as the name of a new project when the user's draft asked for one.
   * @param userId - Telegram user who wrote the message.
   * @param text - the message text.
   * @returns a reply for the caller to send, `''` when the launcher already replied, or undefined when no draft awaits a name.
   */
  async name(userId: number, text: string): Promise<string | undefined> {
    const entry = [...this.drafts.entries()]
      .find(([id, draft]) => draft.userId === userId && draft.awaitingName && this.live(id) !== undefined)
    if (entry === undefined || this.options.projectsDir === undefined) return undefined
    const [id, draft] = entry
    if (!PROJECT_NAME.test(text)) return 'Geçersiz ad: harf, rakam, nokta, tire veya alt çizgi kullanın (en fazla 64 karakter).'
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return '⚠️ Proje kaydı kullanılamıyor.'
    const path = join(this.options.projectsDir, text)
    let project: Project
    try {
      await mkdir(path, { recursive: true })
      if (!await exists(join(path, '.git'))) await run('git', ['init', '--quiet'], { cwd: path })
      const workspace = await registry.create(path)
      project = { id: workspace.id, title: workspace.title }
    } catch (error: unknown) {
      return `⚠️ Proje açılamadı: ${escapeHtml(error instanceof Error ? error.message : String(error))}`
    }
    draft.awaitingName = false
    await this.askMode(id, draft, project)
    return ''
  }

  private async askMode(id: string, draft: Draft, project: Project): Promise<void> {
    const modes = (await this.ctx.get('agentPresets')?.list() ?? []).filter(preset => preset.broken === undefined)
    if (modes.length === 0) {
      this.drafts.delete(id)
      await this.launch(draft, project, undefined)
      return
    }
    draft.chosen = { project, modes }
    const buttons = modes.map((mode, index) => ({ text: modeLabel(mode.id), callback_data: `nw:${id}:m:${String(index)}` }))
    const rows: Button[][] = []
    for (let start = 0; start < buttons.length; start += 3) rows.push(buttons.slice(start, start + 3))
    await this.edit(draft, `${this.heading(draft.task)}\nProje: <b>${escapeHtml(project.title)}</b>\nMod seçin:`, rows)
  }

  private async launch(draft: Draft, project: Project, agentPreset: string | undefined): Promise<void> {
    const where = `<b>${escapeHtml(project.title)}</b>${agentPreset === undefined ? '' : ` · ${escapeHtml(modeLabel(agentPreset))}`}`
    try {
      const controller = this.ctx.get('sessionController')
      if (controller === undefined) throw new Error('oturum denetleyicisi kullanılamıyor')
      const { sessionId } = await controller.create({ workspaceId: project.id, ...agentPreset === undefined ? {} : { agentPreset } })
      await controller.prompt({
        requestId: brandString<SessionRequestId>(randomUUID()),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: draft.task }],
      }, AbortSignal.timeout(30_000))
      await this.edit(draft, `${this.heading(draft.task)}\n🚀 ${where} içinde başlatıldı; konusu ilk turda açılır.`)
    } catch (error: unknown) {
      await this.edit(draft, `${this.heading(draft.task)}\n⚠️ ${where} başlatılamadı: ${escapeHtml(error instanceof Error ? error.message : String(error))}`)
    }
  }

  /** Draft `id` when it exists and has not expired; expired drafts are dropped. */
  private live(id: string): Draft | undefined {
    const now = Date.now()
    for (const [key, draft] of this.drafts) if (now - draft.createdAt > this.options.draftTtlMs) this.drafts.delete(key)
    return this.drafts.get(id)
  }

  private heading(task: string): string {
    return `🆕 <b>Yeni görev:</b> ${escapeHtml(task)}`
  }

  private async edit(draft: Draft, text: string, rows: Button[][] = []): Promise<void> {
    await this.client.enqueue('editMessageText', {
      chat_id: this.options.chatId,
      message_id: draft.messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // A missing path is the expected negative answer.
    return false
  }
}
