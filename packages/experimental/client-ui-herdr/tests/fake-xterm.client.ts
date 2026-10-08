/**
 * A jsdom stand-in for the xterm emulator: it records every call the panel
 * makes and mirrors the written text into its host node, so specs can query the
 * screen by text exactly as a human reads it.
 */

/** Every screen constructed since the last {@link resetFakeTerminals}. */
export const terminals: FakeTerminal[] = []

/** Rows {@link FakeFit} proposes; a spec sets it to drive the height fit. */
export const fit: { rows: number | undefined } = { rows: 30 }

/** Forget every recorded screen and restore the default fit. */
export function resetFakeTerminals(): void {
  terminals.length = 0
  fit.rows = 30
}

/** Recorded xterm double. */
export class FakeTerminal {
  cols: number
  rows: number
  readonly writes: string[] = []
  resets = 0
  disposed = false
  textarea: HTMLTextAreaElement | undefined
  node: HTMLElement | undefined
  /** Scroll state the panel inspects; a spec moves `viewportY` to simulate scrolling up. */
  readonly buffer = { active: { viewportY: 0, baseY: 0 } }
  private listener: ((data: string) => void) | undefined

  /**
   * @param options - the constructor options the panel passes.
   * @param options.cols - initial columns.
   * @param options.rows - initial rows.
   */
  constructor(options: { cols: number; rows: number }) {
    this.cols = options.cols
    this.rows = options.rows
    terminals.push(this)
  }

  /** @param _addon - the fit addon; the fake reads {@link fit} instead. */
  loadAddon(_addon: unknown): void {}

  /** @param node - the host element the panel mounts the screen into. */
  open(node: HTMLElement): void {
    this.node = node
    this.textarea = document.createElement('textarea')
    node.append(this.textarea)
  }

  /**
   * @param listener - receives typed input.
   * @returns the subscription handle.
   */
  onData(listener: (data: string) => void): { dispose: () => void } {
    this.listener = listener
    return { dispose: () => { this.listener = undefined } }
  }

  /**
   * Simulate a keystroke the emulator turned into bytes.
   * @param data - the bytes to deliver.
   */
  type(data: string): void {
    this.listener?.(data)
  }

  /**
   * @param cols - new columns.
   * @param rows - new rows.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  /** Clear the screen and its mirrored text. */
  reset(): void {
    this.resets += 1
    this.writes.length = 0
    this.mirror()
  }

  /** @param data - bytes to append. */
  write(data: string): void {
    this.writes.push(data)
    this.mirror()
  }

  /** Release the screen. */
  dispose(): void {
    this.disposed = true
  }

  private mirror(): void {
    if (this.node === undefined) return
    let screen = this.node.querySelector<HTMLElement>('[data-fake-screen]')
    if (screen === null) {
      screen = document.createElement('div')
      screen.dataset.fakeScreen = ''
      this.node.append(screen)
    }
    screen.textContent = this.writes.join('')
  }
}

/** Fit addon double proposing {@link fit} rows. */
export class FakeFit {
  /** @returns the proposed size, or undefined when the spec withholds one. */
  proposeDimensions(): { cols: number; rows: number } | undefined {
    return fit.rows === undefined ? undefined : { cols: 0, rows: fit.rows }
  }
}
