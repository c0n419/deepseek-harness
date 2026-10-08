/**
 * Loads the generated Host-for-Client descriptor for this package and pins the
 * wire arity of every Remote method.
 *
 * The client gateway rejects a call whose argument count differs from
 * `descriptor.parameters.length`, and the generator writes `acceptsUndefined`
 * rather than `optional` into the runtime descriptor, so an authored optional
 * parameter is not omissible at all: `read(paneId, lines?)` failed live with
 * `herdr/read expected 2 argument(s), got 1`. This asserts the invariant the
 * contract now keeps — no Herdr Remote parameter accepts `undefined` — so that
 * shape cannot come back unnoticed.
 *
 * The descriptor exists only after a build, so the suite skips on a tree built
 * without this package, exactly as the repo's other built-artifact smokes do.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/** One generated parameter descriptor, as the client consumes it. */
interface GeneratedParameter {
  /** Parameter name as authored on the Host method. */
  readonly name: string
  /** Set when the authored type admitted `undefined`. */
  readonly acceptsUndefined?: boolean
}

/** One generated Remote method descriptor. */
interface GeneratedDescriptor {
  /** Endpoint id, e.g. `@deepseek-ai/dsh-experimental-herdr#herdr/read`. */
  readonly id: string
  /** Cordis service key. */
  readonly service: string
  /** Wire method name. */
  readonly method: string
  /** Parameters the client must supply, positionally. */
  readonly parameters: readonly GeneratedParameter[]
  /** Present when the method is a logical stream. */
  readonly mode?: string
}

/** The generated contribution this package publishes. */
interface GeneratedRemote {
  /** Package name the artifact was generated for. */
  readonly package: string
  /** Every Remote method the artifact exports. */
  readonly descriptors: readonly GeneratedDescriptor[]
}

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const artifactPath = resolve(packageDir, 'lib/typert.remote-client.js')
const built = existsSync(artifactPath)

describe.skipIf(!built)('generated Herdr Remote descriptors', () => {
  // A dynamic import is required: the descriptor is a build artifact whose path
  // is only known at runtime, and importing it statically would make this suite
  // depend on `lib/` existing for every other test in the package.
  const load = async (): Promise<GeneratedRemote> => {
    const module: unknown = await import(pathToFileURL(artifactPath).href)
    if (typeof module !== 'object' || module === null || !('TYPERT_REMOTE' in module)) {
      throw new Error('generated remote artifact exports no TYPERT_REMOTE')
    }
    return module.TYPERT_REMOTE as GeneratedRemote
  }

  it('declares no parameter that accepts undefined, so every call is fixed-arity', async () => {
    const remote = await load()
    expect(remote.package).toBe('@deepseek-ai/dsh-experimental-herdr')
    const offending = remote.descriptors.flatMap(descriptor =>
      descriptor.parameters
        .filter(parameter => parameter.acceptsUndefined === true)
        .map(parameter => `${descriptor.id}: ${parameter.name}`))
    // An authored optional parameter would appear here, and the client would then
    // refuse the one-argument call the panel makes.
    expect(offending).toEqual([])
  })

  it('exposes exactly the contract methods with their parameter counts', async () => {
    const remote = await load()
    const signatures = remote.descriptors
      .map(descriptor => [descriptor.id.split('#')[1], descriptor.parameters.map(parameter => parameter.name)] as const)
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
    expect(signatures).toEqual([
      ['herdr/focus', ['paneId']],
      ['herdr/prompt', ['paneId', 'text']],
      ['herdr/read', ['paneId']],
      ['herdr/sendKeys', ['paneId', 'keys']],
      // A stream method carries its cancellation signal as a separate
      // `cancellation` field, not among the positional parameters, so `watch` is
      // callable with no arguments.
      ['herdr/watch', []],
    ])
  })

  it('keeps the checked-in artifact current with the source', () => {
    // The declaration file names the wire methods, so a stale build that still
    // declared HerdrTarget or a two-argument read would show here.
    const declaration = readFileSync(join(packageDir, 'lib/typert.remote-client.d.ts'), 'utf8')
    expect(declaration).toContain('read: (paneId: HerdrPaneId)')
    expect(declaration).not.toContain('HerdrTarget')
    expect(declaration).not.toContain('lines')
  })
})
