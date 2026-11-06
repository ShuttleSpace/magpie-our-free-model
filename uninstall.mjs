/**
 * Magpie's uninstall entry (`magpie.uninstall`).
 *
 * Magpie loads this even when the provider is disabled, so it must never start
 * the service, download a runtime or read credential material. It only removes
 * directories this plugin registered and the `our-free-model` sign-ins.
 */
import { cleanupInstallation } from './installation-state.mjs'

export default async function uninstall(input, options = {}) {
  const managed = options?.managed
  await cleanupInstallation(input, managed && typeof managed === 'object' ? managed : {})
}
