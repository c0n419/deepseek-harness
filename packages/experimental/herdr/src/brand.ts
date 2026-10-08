/**
 * The service's branded handles and their factories. Branding happens exactly
 * once, where a wire value enters the seam; every later use carries the type.
 * The factories do not validate — the Herdr server is the authority on which
 * handles exist, and an unknown one comes back as `*_not_found`.
 * @module @deepseek-ai/dsh-experimental-herdr/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

// Each handle's type and its factory share one name here, so a consumer imports
// both from this module; `types.ts` owns the same types for the wire vocabulary.
/** Opaque `w<N>` workspace handle. */
export type HerdrWorkspaceId = Branded<'HerdrWorkspaceId'>

/** Opaque `w<N>:t<N>` tab handle. */
export type HerdrTabId = Branded<'HerdrTabId'>

/** Opaque `w<N>:p<N>` pane handle. */
export type HerdrPaneId = Branded<'HerdrPaneId'>

/** A live agent name, unique among the agents of one Herdr server. */
export type HerdrAgentName = Branded<'HerdrAgentName'>

/**
 * Brand a wire string as a {@link HerdrWorkspaceId}.
 * @param value - workspace handle as the server spelled it.
 * @returns the same string, branded.
 */
export function HerdrWorkspaceId(value: string): HerdrWorkspaceId {
  return value as HerdrWorkspaceId
}

/**
 * Brand a wire string as a {@link HerdrTabId}.
 * @param value - tab handle as the server spelled it.
 * @returns the same string, branded.
 */
export function HerdrTabId(value: string): HerdrTabId {
  return value as HerdrTabId
}

/**
 * Brand a wire string as a {@link HerdrPaneId}.
 * @param value - pane handle as the server spelled it.
 * @returns the same string, branded.
 */
export function HerdrPaneId(value: string): HerdrPaneId {
  return value as HerdrPaneId
}

/**
 * Brand a wire string as a {@link HerdrAgentName}.
 * @param value - agent name as the server reported it.
 * @returns the same string, branded.
 */
export function HerdrAgentName(value: string): HerdrAgentName {
  return value as HerdrAgentName
}
