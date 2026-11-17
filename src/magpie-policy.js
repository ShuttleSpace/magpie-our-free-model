/**
 * magpie-branch channel policy: no channel is excluded.
 *
 * Upstream main keeps the WorkBuddy / CodeBuddy / Huawei Cloud exclusion in
 * this module. This branch deliberately offers those channels, so every hook
 * below is a pass-through. The exports stay intact because the engine, the
 * aggregate registry, the standalone provider directory and the model catalog
 * all ask this one question before showing or accepting a channel.
 *
 * POLICY_REFUSED is retained only so the engine's legacy error branch keeps
 * compiling; nothing on this branch raises it.
 */

/** @deprecated No policy refusal exists on this branch. */
export const POLICY_REFUSED = 'WorkBuddy and Huawei Cloud are not offered by this build'

/** No channel is denied here. */
export function isDeniedChannel() {
  return false
}

/** No engine response needs rewriting. */
export function policyResponse() {
  return false
}

/** Return the engine answer untouched. */
export function filterEngineJSON(pathname, value) {
  return value
}

/** Plugin detail lookups are never refused. */
export function deniedLookup() {
  return false
}

/** Model rows are never filtered by channel. */
export function deniedModel() {
  return false
}

/** No request body has to be buffered for a policy decision. */
export function policyMutation() {
  return false
}

/** No mutation is refused by policy. */
export function assertEngineMutation() {}
