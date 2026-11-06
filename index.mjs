/**
 * Magpie host entry.
 *
 * Magpie resolves `exports["./server"]` before `main`, so adding this export
 * leaves the DSH plugin entry (`index.js`) unchanged for the same package.
 */
import { createManagedPlugin } from './managed.mjs'

export async function OurFreeModelPlugin(input, options = {}) {
  if (options.managed === false) return {}
  return createManagedPlugin(input, options.managed ?? {})
}
