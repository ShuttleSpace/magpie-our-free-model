/**
 * Ownership bookkeeping for the Magpie installation.
 *
 * Magpie can remove a plugin without running its provider, so uninstall needs
 * its own record of which data directories this plugin created. Only a
 * directory carrying the matching ownership marker is ever touched; anything
 * unrecognised is left in place and the directory is kept.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PRODUCT = 'dsh-our-free-model-magpie'
const REGISTRY = 'dsh-our-free-model-magpie-owned.json'
const MARKER = '.dsh-ofm-magpie-owner.json'
const LOCK = '.dsh-ofm-magpie-lifecycle.lock'
const packageDir = fileURLToPath(new URL('../', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Files and directories the standalone runtime writes into its data directory.
const ownedFiles = new Set([
  'settings.json', 'stats.json', 'availability.json', 'catalog.json',
  'channel-credentials.json', 'eac-user.json', 'workbench.json',
  'workbench-library.json', 'upgrade-state.json', 'updates.json', 'service.lock',
])
const ownedDirs = new Set([
  'subscriptions', 'clients', 'egress', 'magpie', 'engine-runtime',
  'desktop-updates', 'upgrade-stage', 'rollback', 'runtime', 'channel-pack', 'temporary',
])

export function validateDataDir(dataDir, directory) {
  for (const protectedDir of [path.parse(dataDir).root, os.homedir(), path.resolve(directory), packageDir]) {
    if (protectedDir === dataDir || protectedDir.startsWith(dataDir + path.sep)) {
      throw new Error('managed.dataDir 必须是本插件专用的子目录，不能是系统根目录、主目录、Magpie 配置目录或源码目录')
    }
  }
}

async function json(file, optional = true) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined
    throw new Error('清理登记或配置文件无法读取；请修复文件后重试，未将读取失败视为空数据')
  }
}

async function save(file, value) {
  const temporary = `${file}.ofm.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

export async function withFileLock(file, work, timeout = 15000, staleEmptyAfter) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const until = Date.now() + timeout
  while (true) {
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const value = JSON.parse(await fs.readFile(file, 'utf8'))
        if (Number.isSafeInteger(value.pid) && !alive(value.pid)) { await fs.rm(file, { force: true }); continue }
      } catch {
        // Magpie's auth lock is deliberately empty and expires after ten
        // seconds. Our own locks require a provably dead owner instead.
        if (staleEmptyAfter !== undefined) {
          try {
            if ((await fs.readFile(file, 'utf8')) === '' && Date.now() - (await fs.stat(file)).mtimeMs > staleEmptyAfter) {
              await fs.rm(file, { force: true })
              continue
            }
          } catch { /* The next attempt handles a lock released concurrently. */ }
        }
      }
      if (Date.now() >= until) throw new Error('本插件仍在启动或清理，暂时无法获得清理锁；请稍后重试')
      await pause(50)
    }
  }
  try { return await work() } finally {
    try {
      if (JSON.parse(await fs.readFile(file, 'utf8')).nonce === nonce) await fs.rm(file)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

async function registry(directory) {
  const value = await json(path.join(directory, REGISTRY))
  if (!value) return { product: PRODUCT, version: 1, roots: [] }
  if (value.product !== PRODUCT || value.version !== 1 || !Array.isArray(value.roots) || value.roots.some(root =>
    !root || typeof root.path !== 'string' || !path.isAbsolute(root.path) ||
    typeof root.realPath !== 'string' || !path.isAbsolute(root.realPath) || typeof root.token !== 'string')) {
    throw new Error('本插件清理登记不完整；保留文件并停止卸载')
  }
  return value
}

/** Record a data directory before it is used, so uninstall can find it later. */
export async function registerInstallation(directory, dataDir) {
  directory = path.resolve(directory)
  validateDataDir(dataDir, directory)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const realPath = await fs.realpath(dataDir)
  validateDataDir(realPath, await fs.realpath(directory))
  if ((await fs.lstat(dataDir)).isSymbolicLink()) throw new Error('本插件数据目录不能是符号链接')
  await withFileLock(path.join(directory, `${REGISTRY}.lock`), async () => {
    const state = await registry(directory)
    let marker = await json(path.join(dataDir, MARKER))
    if (marker && (marker.product !== PRODUCT || marker.directory !== directory || marker.realPath !== realPath)) {
      throw new Error('数据目录属于另一个安装实例；请使用独立的 managed.dataDir')
    }
    if (!marker) {
      marker = { product: PRODUCT, directory, realPath, token: crypto.randomBytes(24).toString('hex') }
      await save(path.join(dataDir, MARKER), marker)
    }
    state.roots = state.roots.filter(root => root.path !== dataDir || root.cleaned !== true || root.token === marker.token)
    const existing = state.roots.find(root => root.path === dataDir && root.token === marker.token)
    if (existing?.cleaned === true) {
      delete existing.cleaned
      await save(path.join(directory, REGISTRY), state)
    }
    if (!state.roots.some(root => root.path === dataDir && root.token === marker.token)) {
      state.roots.push({ path: dataDir, realPath, token: marker.token })
      await save(path.join(directory, REGISTRY), state)
    }
  })
}

export async function withInstallationLock(dataDir, work) {
  return withFileLock(path.join(dataDir, LOCK), work)
}

async function stopped(dataDir) {
  const until = Date.now() + 10000
  while (true) {
    const lock = await json(path.join(dataDir, 'service.lock'))
    if (!lock) return
    if (lock.product !== 'our-free-model-standalone' || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
      throw new Error('服务锁无法确认归属；保留数据并停止卸载')
    }
    if (!alive(lock.pid)) return
    if (Date.now() >= until) throw new Error('另一个 Magpie 实例仍在使用本插件；请关闭它后重新卸载')
    await pause(50)
  }
}

function isOwned(name) {
  return ownedFiles.has(name) || ownedDirs.has(name) ||
    [...ownedFiles, MARKER].some(file =>
      name.startsWith(`${file}.`) && /^[a-zA-Z0-9.]+\.tmp$/.test(name.slice(file.length + 1)))
}

async function removeRoot(root, directory, recordCleaned) {
  validateDataDir(root.path, directory)
  try {
    if ((await fs.lstat(root.path)).isSymbolicLink() || await fs.realpath(root.path) !== root.realPath) {
      throw new Error('数据目录已被移动或替换为链接；保留文件并停止卸载')
    }
  } catch (error) { if (error.code === 'ENOENT') return; throw error }
  validateDataDir(root.realPath, await fs.realpath(directory))
  const marker = await json(path.join(root.path, MARKER))
  if (marker
    ? marker.product !== PRODUCT || marker.token !== root.token || marker.realPath !== root.realPath || marker.directory !== directory
    : root.cleaned !== true) {
    throw new Error('数据目录清理标记不匹配；保留文件并停止卸载')
  }
  await withInstallationLock(root.path, async () => {
    if (root.cleaned === true) {
      await fs.rm(path.join(root.path, MARKER), { force: true })
      return
    }
    await stopped(root.path)
    for (const name of await fs.readdir(root.path)) {
      if (isOwned(name)) await fs.rm(path.join(root.path, name), { recursive: true, force: true })
    }
    // Persist completion before removing the ownership marker. If a later
    // journal write fails, a retry can finish without touching unrelated files.
    await recordCleaned()
    await fs.rm(path.join(root.path, MARKER), { force: true })
  })
  await fs.rmdir(root.path).catch(error => { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error })
}

async function clearAuth(directory) {
  const file = path.join(directory, 'plugin-auth.json')
  await withFileLock(`${file}.lock`, async () => {
    const all = await json(file)
    if (all) {
      for (const key of Object.keys(all)) {
        if (['our-free-model', 'our-free-model-plugin'].some(id => key === id || key.startsWith(`${id}#`))) {
          delete all[key]
        }
      }
      if (Object.keys(all).length) await save(file, all)
      else await fs.rm(file, { force: true })
    }
    for (const name of await fs.readdir(directory)) {
      if (/^plugin-auth\.json\.ofm\.\d+\.[a-f0-9]{12}\.tmp$/.test(name)) await fs.rm(path.join(directory, name), { force: true })
    }
  }, 15000, 10000)
}

/** Magpie's uninstall entry: remove this plugin's data and its saved sign-ins. */
export async function cleanupInstallation(input, options = {}) {
  if (!input?.directory && !input?.worktree) throw new Error('卸载入口缺少 Magpie 配置目录')
  const directory = path.resolve(input.directory ?? input.worktree)
  let state = await registry(directory)
  // Adopt the pre-registry layout only when an OFM settings record proves it.
  let current = path.resolve(options.dataDir ?? path.join(directory, 'our-free-model'))
  validateDataDir(current, directory)
  try { current = await fs.realpath(current) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!state.roots.some(root => root.path === current)) {
    const settings = await json(path.join(current, 'settings.json'))
    if (settings && typeof settings.forwardKey === 'string' && Number.isInteger(settings.standalonePort)) {
      await registerInstallation(directory, current)
    }
  }
  await json(path.join(directory, 'plugin-auth.json')) // Preflight before deleting any account data.
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await withFileLock(path.join(directory, `${REGISTRY}.lock`), async () => {
    state = await registry(directory)
    for (const root of [...state.roots]) {
      await removeRoot(root, directory, async () => {
        root.cleaned = true
        await save(path.join(directory, REGISTRY), state)
      })
      state.roots = state.roots.filter(row => row !== root)
      await save(path.join(directory, REGISTRY), state)
    }
    await clearAuth(directory)
    for (const name of await fs.readdir(directory)) {
      if (/^dsh-our-free-model-magpie-owned\.json\.ofm\.\d+\.[a-f0-9]{12}\.tmp$/.test(name)) {
        await fs.rm(path.join(directory, name), { force: true })
      }
    }
    await fs.rm(path.join(directory, REGISTRY), { force: true })
  })
}
