/**
 * The plugin host's handle on the standalone service.
 *
 * The service runs in a Node child so Bun never has to load the channel worker.
 * The child is owned through its pipes: when the plugin host exits, stdin
 * closes and the child shuts itself down.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolveNodeRuntime } from './node.mjs'
import { registerInstallation, validateDataDir, withInstallationLock } from './installation-state.mjs'

const instances = new Map()
const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url))
const START_TIMEOUT = 45000

const environment = () => {
  const env = { ...process.env }
  // Never inject another runtime's loaders or reuse DSH's configuration.
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.DSH_HOME
  delete env.OFM_HOME
  return env
}

export function getManagedRuntime(input = {}, options = {}) {
  const directory = input.directory || input.worktree || path.join(os.homedir(), '.config', 'magpie')
  let dataDir = path.resolve(options.dataDir || path.join(directory, 'our-free-model'))
  validateDataDir(dataDir, directory)
  // The standalone store refuses any symlink on its managed path. Canonicalize
  // once here so a symlinked config directory (or macOS /var) still works.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  dataDir = fs.realpathSync(dataDir)
  validateDataDir(dataDir, directory)
  const port = options.port
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error('managed.port 必须为 0 到 65535 的整数')
  }
  if (options.nodePath !== undefined && (typeof options.nodePath !== 'string' || !options.nodePath.trim())) {
    throw new Error('managed.nodePath 必须为非空路径')
  }
  if (options.autoInstallNode !== undefined && typeof options.autoInstallNode !== 'boolean') {
    throw new Error('managed.autoInstallNode 必须为布尔值')
  }
  if (options.refresh !== undefined && typeof options.refresh !== 'boolean') {
    throw new Error('managed.refresh 必须为布尔值')
  }
  const identity = JSON.stringify([dataDir, port, options.nodePath, options.refresh !== false, options.autoInstallNode !== false])
  if (instances.has(dataDir)) {
    const entry = instances.get(dataDir)
    if (entry.identity !== identity) throw new Error('同一数据目录使用了不同服务设置；重启 Magpie 后再应用配置')
    return entry
  }

  let child
  let state
  let pending
  let closing
  let sequence = 0
  let disposed = false
  const calls = new Map()

  const runtime = {
    dataDir,
    identity,
    async ensure() {
      if (disposed) throw new Error('本插件正在卸载，不能重新启动服务')
      if (closing) {
        await closing
        closing = undefined
        if (disposed) throw new Error('本插件正在卸载，不能重新启动服务')
      }
      if (state && child?.exitCode === null && !child.killed) return state
      if (pending) return pending
      pending = (async () => {
        if (disposed) throw new Error('本插件正在卸载，不能重新启动服务')
        await registerInstallation(directory, dataDir)
        return withInstallationLock(dataDir, async () => {
          const node = await resolveNodeRuntime(options, dataDir, environment())
          const processHandle = spawn(node, [runner], {
            env: environment(),
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
          })
          child = processHandle
          processHandle.stdin.on('error', () => {})
          const exit = new Promise(resolve => processHandle.once('exit', resolve))
          processHandle.once('exit', () => {
            if (child === processHandle) state = undefined
            for (const call of calls.values()) call.reject(new Error('内置服务已退出'))
            calls.clear()
          })
          runtime.exited = exit
          const ready = await new Promise((resolve, reject) => {
            const lines = createInterface({ input: processHandle.stdout })
            const timer = setTimeout(() => {
              processHandle.kill('SIGKILL')
              finish(new Error('内置服务启动超时'))
            }, START_TIMEOUT)
            const finish = (error, value) => {
              clearTimeout(timer)
              if (error) lines.close()
              processHandle.off('error', onError)
              processHandle.off('exit', onExit)
              if (error) { processHandle.stdin.end(); reject(error) } else resolve(value)
            }
            const onError = () => finish(new Error('无法启动 Node 内置服务'))
            const onExit = () => finish(new Error('内置服务在启动时退出'))
            processHandle.once('error', onError)
            processHandle.once('exit', onExit)
            lines.on('line', line => {
              try {
                const reply = JSON.parse(line)
                if (reply.type === 'ready') finish(null, reply)
                if (reply.type === 'error') finish(new Error(reply.message))
                if (reply.id && calls.has(reply.id)) {
                  const call = calls.get(reply.id)
                  calls.delete(reply.id)
                  if (reply.error) call.reject(new Error(reply.error))
                  else call.resolve(reply.value)
                }
              } catch { finish(new Error('内置服务返回了无效启动信息')) }
            })
            processHandle.stdin.write(`${JSON.stringify({
              dataDir,
              port,
              refresh: options.refresh !== false,
              parentPid: process.pid,
            })}\n`)
          })
          state = ready
          processHandle.unref()
          processHandle.stdin.unref?.()
          processHandle.stdout.unref?.()
          return state
        })
      })().finally(() => { pending = undefined })
      return pending
    },
    async connection() {
      const current = await runtime.ensure()
      const settings = JSON.parse(fs.readFileSync(current.keyFile, 'utf8'))
      if (typeof settings.forwardKey !== 'string' || settings.forwardKey === '') {
        throw new Error('内置服务密钥不可用')
      }
      return { base: `${current.url}/v1`, key: settings.forwardKey }
    },
    async command(type, payload = {}, signal) {
      await runtime.ensure()
      signal?.throwIfAborted()
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); calls.delete(id) }
        const abort = () => { cleanup(); reject(signal.reason) }
        const timer = setTimeout(() => { cleanup(); reject(new Error('内置服务管理请求超时')) },
          type === 'console' ? 30000 : 5000)
        calls.set(id, {
          resolve(value) { cleanup(); resolve(value) },
          reject(error) { cleanup(); reject(error) },
        })
        signal?.addEventListener('abort', abort, { once: true })
        child.stdin.write(`${JSON.stringify({ ...payload, type, id })}\n`)
      })
    },
    async close() {
      if (closing) return closing
      closing = (async () => {
        if (pending) { try { await pending } catch {} }
        if (!child || child.exitCode !== null) return
        const current = child
        current.stdin.end()
        const timer = setTimeout(() => current.kill('SIGKILL'), 5000)
        await runtime.exited
        clearTimeout(timer)
        state = undefined
      })()
      return closing
    },
    async dispose() {
      disposed = true
      await runtime.close()
    },
  }
  instances.set(dataDir, runtime)
  return runtime
}
