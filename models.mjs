/**
 * Model rows for the Magpie host plugin.
 *
 * The standalone service is the single source of truth: the plugin never keeps
 * its own catalog. A row is only published when the service would route it, so
 * disabling a model in the console also removes it from Magpie on the next
 * discovery.
 */
import { effortsFor } from './src/effort.js'

export const PROVIDER = 'our-free-model'
export const SDK = '@ai-sdk/openai-compatible'

export function safeID(value) {
  return typeof value === 'string' && value.trim() !== '' &&
    !['__proto__', 'constructor', 'prototype'].includes(value.trim())
}

export function positive(value, defaultValue) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : defaultValue
}

/**
 * The catalog rows the running service currently routes, in a wire shape the
 * plugin host can map without importing the standalone runtime.
 */
export function catalogRows(runtime) {
  const allowed = new Set(runtime.publicModelRows().map(row => row.id))
  const rows = new Map()
  for (const row of runtime.state().catalog) {
    if (!safeID(row?.id) || !allowed.has(row.id) || rows.has(row.id)) continue
    rows.set(row.id, catalogRow(row))
  }
  return [...rows.values()]
}

export function catalogRow(row) {
  const reasoning = row.reasoning
  const declared = reasoning && typeof reasoning === 'object' && Array.isArray(reasoning.efforts)
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : row.id,
    vision: row.vision === true,
    context_window: positive(row.contextWindow ?? row.context_window, 131072),
    max_tokens: positive(row.maxOutput ?? row.max_tokens, 32768),
    reasoning: typeof reasoning === 'object' ? true : reasoning === true,
    reasoning_efforts: declared ? reasoning.efforts : effortsFor(row),
  }
}

/** One Magpie model for a wire row. Unknown effort ids are dropped, not guessed. */
export function toMagpieModel(row, base) {
  if (!safeID(row?.id)) return undefined
  const id = row.id.trim()
  const efforts = Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts : []
  const variants = {}
  for (const value of efforts) {
    const effort = typeof value === 'string' ? value : value?.id
    if (safeID(effort)) variants[effort] = { reasoningEffort: effort }
  }
  return {
    id,
    providerID: PROVIDER,
    name: row.name ?? id,
    api: { id, url: base, npm: SDK },
    limit: {
      context: positive(row.context_window, 32768),
      output: positive(row.max_tokens, 4096),
    },
    capabilities: {
      temperature: true,
      reasoning: row.reasoning === true || efforts.length > 0,
      toolcall: true,
      attachment: false,
      input: { text: true, image: row.vision === true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    options: {},
    headers: {},
    variants,
    status: 'active',
    release_date: '',
  }
}
