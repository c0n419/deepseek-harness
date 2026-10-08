/**
 * Folds Session events from every mode into one tree per root Session — the root plus its
 * teammates and subagents — and derives the Telegram status card and notifications from it.
 * Pure state: it performs no I/O.
 * @module @deepseek-ai/dsh-experimental-telegram-bridge/tracker
 */

import { basename } from 'node:path'

/** The Session facts the tracker reads from every event's Session. */
export interface TrackedHeader {
  readonly id: string
  readonly parentSession?: string | undefined
  readonly cwd?: string | undefined
  readonly agentPreset?: string | undefined
}

/** One Session event, reduced to the fields the tracker reads. */
export interface TrackedEvent {
  readonly type: string
  readonly data?: unknown
}

/** One message the bridge sends into a root Session's topic. */
export interface Notification {
  readonly rootId: string
  readonly text: string
  /** Whether Telegram plays a notification sound. */
  readonly loud: boolean
}

interface Usage {
  input: number
  cached: number
  output: number
}

interface Node {
  readonly id: string
  parent?: string | undefined
  name?: string | undefined
  title?: string | undefined
  preset?: string | undefined
  cwd?: string | undefined
  model?: string | undefined
  running: boolean
  ended?: 'completed' | 'error' | 'aborted' | undefined
  lastText?: string | undefined
  usage: Usage
  steps: number
  compactions: number
}

/** Render options for cards and notifications. */
export interface TrackerOptions {
  /** Maximum characters of agent text quoted in a notification. */
  readonly excerptChars: number
  /** Web UI URL linked from each status card, or undefined for none. */
  readonly webUrl?: string | undefined
}

const MODE_LABELS: Readonly<Record<string, string>> = {
  standard: 'Standard',
  ptc: 'PTC',
  minimal: 'Minimal',
  cordis: 'Creator',
  team: 'Team',
}

/**
 * Display label of an Agent preset id.
 * @param presetId - Agent preset id.
 * @returns the mode label, or the id itself for presets without one.
 */
export function modeLabel(presetId: string): string {
  return MODE_LABELS[presetId] ?? presetId
}

/**
 * Escape text for Telegram HTML parse mode.
 * @param text - raw text.
 * @returns text safe inside Telegram HTML.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function excerpt(value: string, limit: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function tokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : String(value)
}

/** Session tree state for every root Session the bridge has seen. */
export class SessionTracker {
  private readonly nodes = new Map<string, Node>()
  private readonly dirty = new Set<string>()

  constructor(private readonly options: TrackerOptions) {}

  /**
   * Fold one appended Session event.
   * @param header - the event's Session header.
   * @param event - the appended event.
   * @returns notifications this event produces.
   */
  observe(header: TrackedHeader, event: TrackedEvent): Notification[] {
    const node = this.node(header)
    const rootId = this.rootOf(node.id)
    const data = record(event.data)
    const notifications: Notification[] = []
    const isRoot = rootId === node.id
    switch (event.type) {
      case 'session/title':
        node.title = text(data.title) ?? node.title
        break
      case 'request/header':
        node.model = text(record(record(data.header).config).model) ?? node.model
        break
      case 'agent-preset/selected':
        node.preset = text(data.agentPreset) ?? node.preset
        break
      case 'subagent/descriptor':
        node.name ??= text(data.label)
        node.model = text(data.agentModel) ?? node.model
        break
      case 'team/member': {
        const member = record(data.member)
        const id = text(member.id)
        if (id !== undefined) {
          const child = this.nodes.get(id) ?? this.create(id)
          child.parent = node.id
          child.name = text(member.name) ?? child.name
          child.model = text(member.model) ?? child.model
          if (member.phase === 'failed') {
            notifications.push({ rootId, loud: true, text: `❌ <b>${escapeHtml(child.name ?? id)}</b> başlatılamadı: ${escapeHtml(excerpt(text(member.error) ?? '', this.options.excerptChars))}` })
          }
        }
        break
      }
      case 'turn/start':
        node.running = true
        node.ended = undefined
        break
      case 'assistant/message': {
        const message = record(data.message)
        const content = Array.isArray(message.content) ? message.content : []
        const reply = content.map(record).filter(block => block.type === 'text').map(block => text(block.text) ?? '').join('')
        if (reply.trim() !== '') node.lastText = reply
        const usage = record(data.usage)
        node.usage.input += count(usage.inputTokens)
        node.usage.cached += count(usage.cacheReadTokens) + count(usage.cacheWriteTokens)
        node.usage.output += count(usage.outputTokens)
        node.steps += 1
        break
      }
      case 'compaction/start':
        node.compactions += 1
        break
      case 'turn/end': {
        node.running = false
        const reason = record(data.reason)
        const kind = text(reason.kind)
        node.ended = kind === 'error' ? 'error' : kind === 'aborted' ? 'aborted' : 'completed'
        const who = isRoot ? 'Tur' : `<b>${escapeHtml(this.label(node))}</b>`
        if (node.ended === 'error') {
          const failure = text(record(reason.error).message) ?? ''
          notifications.push({ rootId, loud: true, text: `❌ ${who} hata ile bitti: ${escapeHtml(excerpt(failure, this.options.excerptChars))}` })
        } else if (isRoot && node.ended === 'aborted') {
          notifications.push({ rootId, loud: false, text: '⏹ Tur durduruldu.' })
        } else if (isRoot) {
          const quote = node.lastText === undefined ? '' : `\n<blockquote>${escapeHtml(excerpt(node.lastText, this.options.excerptChars))}</blockquote>`
          notifications.push({ rootId, loud: true, text: `✅ Tur bitti.${quote}` })
        }
        break
      }
      case 'tool/call':
        if (data.name === 'ask_user_question') {
          notifications.push({ rootId, loud: true, text: `❓ <b>${escapeHtml(this.label(node))}</b> soru soruyor: ${escapeHtml(excerpt(firstQuestion(text(data.arguments)), this.options.excerptChars))}` })
        }
        break
      default:
        break
    }
    this.dirty.add(rootId)
    return notifications
  }

  /**
   * Whether a root Session has started a turn, which is when it earns a topic.
   * @param rootId - root Session id.
   * @returns true once any Session in the tree has run.
   */
  isActive(rootId: string): boolean {
    return [...this.nodes.values()].some(node => this.rootOf(node.id) === rootId && (node.running || node.ended !== undefined))
  }

  /**
   * Take and clear the root Sessions whose card changed.
   * @returns changed root Session ids.
   */
  takeDirty(): string[] {
    const roots = [...this.dirty]
    this.dirty.clear()
    return roots
  }

  /**
   * Root Session id for any tracked Session.
   * @param id - any Session id.
   * @returns the id at the top of its parent chain.
   */
  rootOf(id: string): string {
    let current = id
    const seen = new Set<string>()
    for (;;) {
      const parent = this.nodes.get(current)?.parent
      if (parent === undefined || seen.has(parent)) return current
      seen.add(current)
      current = parent
    }
  }

  /**
   * Topic name for a root Session: mode, title, and project.
   * @param rootId - root Session id.
   * @returns a name of at most 128 characters.
   */
  topicName(rootId: string): string {
    const root = this.nodes.get(rootId)
    const mode = root?.preset === undefined ? 'Oturum' : modeLabel(root.preset)
    const project = root?.cwd === undefined ? '' : ` · ${basename(root.cwd)}`
    return `[${mode}] ${root?.title ?? rootId.slice(0, 16)}${project}`.slice(0, 128)
  }

  /**
   * Status card HTML for a root Session and its tree.
   * @param rootId - root Session id.
   * @returns Telegram HTML text.
   */
  card(rootId: string): string {
    const root = this.nodes.get(rootId)
    const tree = [...this.nodes.values()].filter(node => this.rootOf(node.id) === rootId)
    const total = tree.reduce<Usage>((sum, node) => ({
      input: sum.input + node.usage.input,
      cached: sum.cached + node.usage.cached,
      output: sum.output + node.usage.output,
    }), { input: 0, cached: 0, output: 0 })
    const prompt = total.input + total.cached
    const lines = [
      `<b>${escapeHtml(this.topicName(rootId))}</b>`,
      `${status(root)} Lead${root?.model === undefined ? '' : ` · ${escapeHtml(root.model)}`}`,
    ]
    for (const child of tree.filter(node => node.id !== rootId)) {
      lines.push(`  ├ ${status(child)} ${escapeHtml(this.label(child))}${child.model === undefined ? '' : ` · ${escapeHtml(child.model)}`}`)
    }
    const compactions = tree.reduce((sum, node) => sum + node.compactions, 0)
    const steps = tree.reduce((sum, node) => sum + node.steps, 0)
    lines.push(`📊 ${String(steps)} adım · girdi ${tokens(prompt)} (önbellek %${prompt === 0 ? 0 : Math.round(100 * total.cached / prompt)}) · çıktı ${tokens(total.output)}${compactions === 0 ? '' : ` · ${String(compactions)} sıkıştırma`}`)
    if (this.options.webUrl !== undefined) lines.push(`<a href="${escapeHtml(this.options.webUrl)}">Web arayüzünde aç</a>`)
    return lines.join('\n')
  }

  /**
   * Root Sessions that have run at least one turn, in first-seen order.
   * @returns root Session ids.
   */
  roots(): string[] {
    return [...this.nodes.values()].filter(node => node.parent === undefined && this.isActive(node.id)).map(node => node.id)
  }

  /**
   * Whether a root Session currently has any running Session in its tree.
   * @param rootId - root Session id.
   * @returns true while any turn in the tree runs.
   */
  running(rootId: string): boolean {
    return [...this.nodes.values()].some(node => this.rootOf(node.id) === rootId && node.running)
  }

  /**
   * Display name of any tracked Session: teammate or subagent name, title, or short id.
   * @param id - Session id.
   * @returns a short label.
   */
  nameOf(id: string): string {
    const node = this.nodes.get(id)
    return node === undefined ? id.slice(0, 8) : this.label(node)
  }

  private label(node: Node): string {
    return node.name ?? node.title ?? node.id.slice(0, 8)
  }

  private node(header: TrackedHeader): Node {
    const node = this.nodes.get(header.id) ?? this.create(header.id)
    if (header.parentSession !== undefined) node.parent = header.parentSession
    node.cwd ??= header.cwd
    node.preset ??= header.agentPreset
    return node
  }

  private create(id: string): Node {
    const node: Node = { id, running: false, usage: { input: 0, cached: 0, output: 0 }, steps: 0, compactions: 0 }
    this.nodes.set(id, node)
    return node
  }
}

function status(node: Node | undefined): string {
  if (node?.running === true) return '🟢'
  if (node?.ended === 'error') return '❌'
  if (node?.ended === 'aborted') return '⏹'
  if (node?.ended === 'completed') return '✅'
  return '⚪'
}

/** First question text of an `ask_user_question` call, or its raw arguments when unparseable. */
function firstQuestion(args: string | undefined): string {
  if (args === undefined) return ''
  try {
    const parsed = record(JSON.parse(args))
    const questions = Array.isArray(parsed.questions) ? parsed.questions : []
    return text(record(questions[0]).question) ?? args
  } catch {
    // Model-produced arguments may be invalid JSON; the raw text still informs the user.
    return args
  }
}
