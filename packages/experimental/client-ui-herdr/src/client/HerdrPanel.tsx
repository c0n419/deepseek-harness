/**
 * The Herdr panel body: the connection states, the workspace → tab → pane tree
 * with status badges, the selected pane's output, and the prompt and key
 * controls. It receives its whole view through one injected observable hook
 * and reaches the Host only through the injected command faces.
 */

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconRefreshOutlineRegular, IconWarningTriangleOutlineRegular,
  StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HerdrAgent, HerdrAgentStatus, HerdrCommandResult, HerdrConnection, HerdrKey, HerdrPane,
  HerdrPaneId, HerdrReadResult, HerdrTab, HerdrView, HerdrWorkspace,
} from '@deepseek-ai/dsh-experimental-herdr/types'
import { NS, type HerdrKey as CopyKey } from './locales.ts'
import css from './HerdrPanel.module.css'

/** Translate function bound to this panel's namespace. */
type Translate = (key: CopyKey, params?: Record<string, unknown>) => string

/** Business state and actions the browser plugin injects into the panel. */
export interface HerdrPanelInjected {
  /** The latest view pushed by the Host, or undefined before the first frame. */
  hooks: { view: HostObservable<HerdrView | undefined> }
  /**
   * Read one pane's recent output.
   * @param paneId - pane to read.
   * @returns the pane text, or the absent-pane result.
   */
  read(paneId: HerdrPaneId): Promise<HerdrReadResult>
  /**
   * Send one prompt to the agent hosted by a pane.
   * @param paneId - pane whose agent receives the prompt.
   * @param text - prompt text.
   * @returns success, or the server's refusal (a pane with no agent refuses).
   */
  prompt(paneId: HerdrPaneId, text: string): Promise<HerdrCommandResult>
  /**
   * Send one permitted key to a pane.
   * @param paneId - pane receiving the keys.
   * @param keys - keys to send.
   * @returns success, or the rejection.
   */
  sendKeys(paneId: HerdrPaneId, keys: readonly HerdrKey[]): Promise<HerdrCommandResult>
  /**
   * Move the server's focus to a pane, agent-hosted or not.
   * @param paneId - pane to focus.
   * @returns success, or the server's refusal.
   */
  focus(paneId: HerdrPaneId): Promise<HerdrCommandResult>
  /** Drop the settled view stream and open a fresh one. */
  restart(): void
}

/**
 * Full props of the Herdr main panel: the injected face with its `hooks`
 * compartment bound to the `useView` selector hook, plus the locale seat.
 */
export type HerdrPanelProps = PropsRuntime<'main'>
  & InjectFace<HerdrPanelInjected>
  & PropsLocale<typeof NS>

/** Keys the panel offers, paired with the dictionary key naming each. */
const KEYS: readonly { readonly key: HerdrKey; readonly dictionaryKey: CopyKey }[] = [
  { key: 'esc', dictionaryKey: 'esc' },
  { key: 'ctrl+c', dictionaryKey: 'ctrlC' },
  { key: 'enter', dictionaryKey: 'enter' },
  { key: 'up', dictionaryKey: 'up' },
  { key: 'down', dictionaryKey: 'down' },
  { key: 'y', dictionaryKey: 'yes' },
  { key: 'n', dictionaryKey: 'no' },
]

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled herdr agent status: ${JSON.stringify(value)}`)
}

/**
 * State-dot semantics for one agent status. `unknown` is neutral: an agent
 * Herdr could not classify, never a finished one.
 * @param status - Herdr's agent status.
 * @returns the dot state.
 */
function statusDot(status: HerdrAgentStatus): StateDotState {
  switch (status) {
    case 'idle': return 'idle'
    case 'working': return 'ongoing'
    case 'blocked': return 'warning'
    case 'done': return 'done'
    case 'unknown': return 'idle'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/**
 * Localized copy key for one agent status.
 * @param status - Herdr's agent status.
 * @returns the dictionary key naming it.
 */
function statusKey(status: HerdrAgentStatus): CopyKey {
  switch (status) {
    case 'idle': return 'statusIdle'
    case 'working': return 'statusWorking'
    case 'blocked': return 'statusBlocked'
    case 'done': return 'statusDone'
    case 'unknown': return 'statusUnknown'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/**
 * Render one status badge: a state dot beside its localized name, labelled for
 * assistive technology so the color carries no meaning alone.
 * @param props.status - Herdr's agent status for the row.
 * @param props.t - namespace-bound translate.
 * @returns the badge element.
 */
function StatusBadge({ status, t }: { readonly status: HerdrAgentStatus; readonly t: Translate }): ReactNode {
  const name = t(statusKey(status))
  return (
    <span className={css.badge} role="img" aria-label={t('statusLabel', { status: name })} data-herdr-status={status}>
      <StateDot state={statusDot(status)} />
      <span>{name}</span>
    </span>
  )
}

/**
 * The agent Herdr recognized in one pane, if any. A pane with no agent reports
 * `agentStatus: 'unknown'`, which is not an agent state at all, so every
 * agent-shaped affordance is gated on this and not on the status.
 * @param pane - pane row.
 * @param agents - every recognized agent in the view.
 * @returns the hosted agent, or undefined for a plain shell.
 */
function hostedAgent(pane: HerdrPane, agents: readonly HerdrAgent[]): HerdrAgent | undefined {
  return agents.find(agent => agent.paneId === pane.paneId)
}

/**
 * Name the agent hosted by one pane.
 * @param pane - pane row.
 * @param agents - every recognized agent in the view.
 * @param t - namespace-bound translate.
 * @returns the live agent name, else its kind, else the no-agent copy.
 */
function agentLabel(pane: HerdrPane, agents: readonly HerdrAgent[], t: Translate): string {
  const hosted = hostedAgent(pane, agents)
  const name = hosted?.name
  if (name !== undefined) return t('agentLabel', { name })
  return hosted?.agent ?? pane.agent ?? t('noAgent')
}

/** Props of the workspace → tab → pane tree. */
interface TreeProps {
  readonly view: HerdrView
  readonly selected: HerdrPaneId | undefined
  readonly onSelect: (paneId: HerdrPaneId) => void
  readonly t: Translate
}

/** The workspace → tab → pane tree with one selectable row per pane. */
function Tree({ view, selected, onSelect, t }: TreeProps): ReactNode {
  const tabsOf = (workspace: HerdrWorkspace): readonly HerdrTab[] =>
    view.tabs.filter(tab => tab.workspaceId === workspace.workspaceId)
  const panesOf = (tab: HerdrTab): readonly HerdrPane[] =>
    view.panes.filter(pane => pane.tabId === tab.tabId)
  if (view.workspaces.length === 0) return <div className={css.tree} data-herdr-tree><p className={css.empty}>{t('empty')}</p></div>
  return (
    <div className={css.tree} data-herdr-tree>
      <h2 className={css.sectionTitle}>{t('workspaces')}</h2>
      {view.workspaces.map(workspace => (
        <div key={workspace.workspaceId} className={css.workspace} data-herdr-workspace={workspace.workspaceId}>
          <div className={css.workspaceRow}>
            <StateDot state={statusDot(workspace.agentStatus)} />
            <span className={css.workspaceName}>{workspace.label}</span>
            <span className={css.headerSpacer} />
            <StatusBadge status={workspace.agentStatus} t={t} />
          </div>
          <div className={css.tabs}>
            {tabsOf(workspace).map(tab => (
              <div key={tab.tabId} data-herdr-tab={tab.tabId}>
                <div className={css.tabRow}>
                  <StateDot state={statusDot(tab.agentStatus)} />
                  <span className={css.paneName}>{tab.label}</span>
                </div>
                <div className={css.panes}>
                  {panesOf(tab).length === 0 && <p className={css.empty}>{t('emptyPanes')}</p>}
                  {panesOf(tab).map(pane => (
                    <button
                      key={pane.paneId}
                      type="button"
                      className={css.paneRow}
                      data-herdr-pane={pane.paneId}
                      data-selected={pane.paneId === selected}
                      aria-pressed={pane.paneId === selected}
                      aria-label={t('selectPane', { id: pane.paneId })}
                      onClick={() => { onSelect(pane.paneId) }}
                    >
                      {hostedAgent(pane, view.agents) !== undefined && <StateDot state={statusDot(pane.agentStatus)} />}
                      <span className={css.paneName}>{pane.terminalTitle ?? t('paneLabel', { id: pane.paneId })}</span>
                      <span className={css.paneAgent}>{agentLabel(pane, view.agents, t)}</span>
                      {pane.focused && <span className={css.focusMark}>{t('focused')}</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {tabsOf(workspace).length === 0 && <p className={css.empty}>{t('emptyTabs')}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Render the connection state in place of a tree the panel cannot trust.
 * @param props.connection - the Host-reported non-connected state.
 * @param props.t - namespace-bound translate.
 * @param props.onRetry - drops the settled stream and opens a fresh one.
 * @returns the notice element.
 */
function Notice({ connection, t, onRetry }: {
  readonly connection: Exclude<HerdrConnection, { status: 'connected' }>
  readonly t: Translate
  readonly onRetry: () => void
}): ReactNode {
  const incompatible = connection.status === 'incompatible'
  return (
    <div className={css.notice} data-herdr-connection={connection.status} role="status">
      <p className={css.noticeTitle}>
        <IconWarningTriangleOutlineRegular size={16} />
        {t(incompatible ? 'incompatible' : 'unavailable')}
      </p>
      <p className={css.noticeHint}>
        {incompatible
          ? t('incompatibleHint', { expected: connection.expected, actual: connection.actual })
          : t('unavailableHint')}
      </p>
      {connection.status === 'unavailable' && (
        <p className={css.noticeHint}>{t('unavailableReason', { reason: connection.reason })}</p>
      )}
      {/* Both non-connected states recover the same way — a fresh watch, which
          the Host answers by probing the server again — so both offer Retry. */}
      <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={16} />} onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}

/**
 * Render the Herdr panel: connection line, tree, selected pane output, and the
 * prompt and key controls.
 * @param props - the main-panel share, the injected view and commands, and copy.
 * @returns the panel element.
 */
export function HerdrPanel({
  useView, read, prompt, sendKeys, focus, restart, t,
}: HerdrPanelProps): ReactNode {
  const view = useView(value => value)
  const [selected, setSelected] = useState<HerdrPaneId | undefined>(undefined)
  // Bumped on every explicit selection so re-picking the pane already shown
  // re-reads it; the revision alone cannot express that intent.
  const [selection, setSelection] = useState(0)
  const [output, setOutput] = useState<{ readonly paneId: HerdrPaneId; readonly value: HerdrReadResult } | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // Request order: only the newest read may land, so a slow read of a pane the
  // human already left cannot overwrite the pane now on screen.
  const reads = useRef(0)
  // One read at a time: a refresh tick that lands while a read is in flight is
  // skipped instead of queued, so a slow server cannot accumulate requests.
  const reading = useRef(false)
  const outputBox = useRef<HTMLPreElement>(null)
  // Whether the output box follows new text. Scrolling up to read history
  // releases it; scrolling back to the bottom, or picking a pane, re-engages it.
  const following = useRef(true)

  const selectedPane = view?.panes.find(pane => pane.paneId === selected)
  const shown = selected !== undefined && output?.paneId === selected ? output.value : undefined
  // The pushed revision of the selected pane; a change re-reads its output.
  const revision = selectedPane?.revision

  /** Report one outcome: a refusal or a thrown failure, never both silently. */
  const settle = (result: HerdrCommandResult): void => {
    setFailure(result.ok ? undefined : t('commandRejected', { code: result.code }))
  }

  const run = async (command: () => Promise<HerdrCommandResult>): Promise<void> => {
    setPending(true)
    try {
      settle(await command())
    } catch (error: unknown) {
      setFailure(t('commandFailed', { message: messageOf(error) }))
    } finally {
      setPending(false)
    }
  }

  const load = async (paneId: HerdrPaneId): Promise<void> => {
    const request = reads.current + 1
    reads.current = request
    reading.current = true
    try {
      const value = await read(paneId)
      if (request !== reads.current) return
      setOutput({ paneId, value })
      setFailure(undefined)
    } catch (error: unknown) {
      if (request !== reads.current) return
      setFailure(t('commandFailed', { message: messageOf(error) }))
    } finally {
      if (request === reads.current) reading.current = false
    }
  }

  // Read on selection and whenever the pushed revision moves (agent state).
  useEffect(() => {
    if (selected === undefined || revision === undefined) return
    void load(selected)
  }, [selected, revision, selection])

  // Herdr pushes no event when a plain shell prints, so the shown pane also
  // follows its output by re-reading at the Host-configured interval.
  const refreshMs = view?.outputRefreshMs
  useEffect(() => {
    if (selected === undefined || refreshMs === undefined) return
    const timer = setInterval(() => {
      if (!reading.current) void load(selected)
    }, refreshMs)
    return () => { clearInterval(timer) }
  }, [selected, refreshMs])

  // Keep the newest output in sight while the box is following.
  const shownText = shown !== undefined && 'text' in shown ? shown.text : undefined
  useLayoutEffect(() => {
    const box = outputBox.current
    if (box !== null && following.current) box.scrollTop = box.scrollHeight
  }, [shownText])

  /** Track whether the human scrolled away from the newest output. */
  const onOutputScroll = (): void => {
    const box = outputBox.current
    /* v8 ignore next -- the handler is attached to the element the ref holds */
    if (box === null) return
    following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 8
  }

  const select = (paneId: HerdrPaneId): void => {
    setSelected(paneId)
    setSelection(selection + 1)
    following.current = true
    setFailure(undefined)
    setOutput(undefined)
  }

  // Prompting needs an agent in the pane; every other control works on the pane
  // itself, so only the prompt box is withheld for a plain shell.
  const agentHosted = selectedPane !== undefined && view !== undefined
    && hostedAgent(selectedPane, view.agents) !== undefined
  /** Send the current draft to the selected pane's agent, then show the pane's reaction. */
  const send = (paneId: HerdrPaneId): void => {
    const text = draft
    void run(async () => {
      const result = await prompt(paneId, text)
      if (result.ok) setDraft('')
      return result
    }).then(() => load(paneId))
  }

  /** Submit the prompt form: Enter in the box or the Send button. */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (selected === undefined || !agentHosted || pending || draft.trim() === '') return
    send(selected)
  }

  return (
    <div className={css.page} data-herdr-panel>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <span className={css.headerSpacer} />
        {view !== undefined && (
          <span className={css.connection} data-herdr-connection={view.connection.status}>
            {view.connection.status === 'connected'
              ? t('connected', { version: view.connection.version, protocol: view.connection.protocol })
              : t(view.connection.status === 'incompatible' ? 'incompatible' : 'unavailable')}
          </span>
        )}
      </header>
      <div className={css.body}>
        {view === undefined
          ? <p className={css.empty}>{t('reading')}</p>
          : view.connection.status !== 'connected'
            ? <Notice connection={view.connection} t={t} onRetry={restart} />
            : (
              <>
                <Tree view={view} selected={selected} onSelect={select} t={t} />
                <section className={css.detail} data-herdr-detail>
                  <div className={css.outputPanel}>
                    <div className={css.outputHead}>
                      <h2 className={css.sectionTitle}>{t('output')}</h2>
                      <span className={css.headerSpacer} />
                      {selectedPane !== undefined && hostedAgent(selectedPane, view.agents) !== undefined && (
                        <StatusBadge status={selectedPane.agentStatus} t={t} />
                      )}
                      {selectedPane !== undefined && selected !== undefined && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => { void run(() => focus(selected)) }}
                        >
                          {t('focusPane')}
                        </Button>
                      )}
                    </div>
                    {selectedPane === undefined
                      ? <p className={css.empty}>{t('selectedPane')}</p>
                      : shown === undefined
                        ? <p className={css.empty}>{t('reading')}</p>
                        : 'notFound' in shown
                          ? <p className={css.empty}>{t('outputNotFound')}</p>
                          : (
                            <>
                              <pre ref={outputBox} className={css.output} data-herdr-output onScroll={onOutputScroll}>{shown.text === '' ? t('outputEmpty') : shown.text}</pre>
                              {shown.truncated && <p className={css.empty}>{t('outputTruncated')}</p>}
                            </>
                          )}
                  </div>
                  {/* The controls act on the selected pane, so they render only
                      with one; without a selection the panel asks for one. */}
                  {selected !== undefined && <div className={css.controls}>
                    {failure !== undefined && <p className={css.error} role="alert">{failure}</p>}
                    <form className={css.promptRow} onSubmit={submit}>
                      <input
                        className={css.promptInput}
                        type="text"
                        value={draft}
                        placeholder={t(agentHosted ? 'promptPlaceholder' : 'noAgent')}
                        aria-label={t('prompt')}
                        disabled={!agentHosted}
                        onChange={(event) => { setDraft(event.target.value) }}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!agentHosted || pending || draft.trim() === ''}
                      >
                        {pending ? t('sending') : t('send')}
                      </Button>
                    </form>
                    <div className={css.keyRow}>
                      <span className={css.keyLabel}>{t('keys')}</span>
                      {KEYS.map(({ key, dictionaryKey }) => (
                        <Button
                          key={key}
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => { void run(() => sendKeys(selected, [key])).then(() => load(selected)) }}
                        >
                          {t(dictionaryKey)}
                        </Button>
                      ))}
                    </div>
                  </div>}
                </section>
              </>
            )}
      </div>
    </div>
  )
}

/**
 * Describe one thrown value for the panel's error line.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
