/**
 * One Herdr pane rendered in an xterm screen: the pane's recent output with its
 * colors, wrapped at the pane's own column count, and every keystroke typed
 * into the screen forwarded to the pane as raw terminal input.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import css from './HerdrPanel.module.css'

/** Props of one pane screen. */
export interface PaneTerminalProps {
  /** Recent output rows with SGR color sequences, as the Host read them. */
  readonly text: string
  /** The pane's terminal columns; the screen wraps exactly where the pane does. */
  readonly cols: number
  /** Accessible name of the screen's input. */
  readonly label: string
  /**
   * Forward raw input the screen produced from keystrokes.
   * @param data - the bytes xterm emitted, escape sequences included.
   */
  readonly onInput: (data: string) => void
}

/** Rows the screen starts with before the container is measured. */
const INITIAL_ROWS = 24

/**
 * Normalize one read for the emulator: rows end in CRLF so each starts at
 * column zero, and trailing blank rows are dropped so the cursor rests at the
 * end of the last real row, which is where a shell prompt sits.
 * @param text - the Host read.
 * @returns the bytes to write after a reset.
 */
export function screenBytes(text: string): string {
  return text.replace(/\r?\n/g, '\r\n').replace(/(?:\r\n(?:\u001b\[[0-9;]*m)*[ \t]*)+$/, '')
}

/**
 * Render one pane as a live terminal screen. A new read replaces the screen
 * only while the human is at the bottom of its history, so scrolling up to read
 * older output is not interrupted by the next refresh.
 * @param props - the read, its column count, the input sink, and the label.
 * @returns the screen element.
 */
export function PaneTerminal({ text, cols, label, onInput }: PaneTerminalProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const screen = useRef<{ terminal: Terminal; fit: FitAddon } | undefined>(undefined)
  // The latest sink, so the one subscription made at mount never calls a stale pane.
  const sink = useRef(onInput)
  sink.current = onInput

  useEffect(() => {
    /* v8 ignore next -- React attaches the ref before running the effect */
    if (host.current === null) return
    const terminal = new Terminal({
      cols,
      rows: INITIAL_ROWS,
      scrollback: 5000,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current)
    terminal.textarea?.setAttribute('aria-label', label)
    const input = terminal.onData((data) => { sink.current(data) })
    screen.current = { terminal, fit }
    // Height follows the panel; width stays the pane's, so rows never re-wrap.
    const resize = (): void => {
      const rows = fit.proposeDimensions()?.rows
      if (rows !== undefined && rows > 0) terminal.resize(terminal.cols, rows)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host.current)
    resize()
    return () => {
      observer.disconnect()
      input.dispose()
      screen.current = undefined
      terminal.dispose()
    }
  }, [])

  useEffect(() => {
    const current = screen.current
    /* v8 ignore next -- the mount effect runs first and sets the screen */
    if (current === undefined) return
    const { terminal } = current
    if (terminal.cols !== cols) terminal.resize(cols, terminal.rows)
    const buffer = terminal.buffer.active
    if (buffer.viewportY < buffer.baseY) return
    terminal.reset()
    terminal.write(screenBytes(text))
  }, [text, cols])

  useEffect(() => {
    screen.current?.terminal.textarea?.setAttribute('aria-label', label)
  }, [label])

  return <div ref={host} className={css.terminal} data-herdr-terminal />
}
