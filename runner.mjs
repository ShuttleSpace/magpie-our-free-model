/**
 * Runs in Node, not in Magpie's Bun host.
 *
 * The standalone service loads the channel worker, which needs `node:sqlite`
 * and `node:worker_threads`; Bun does not provide the former. Keeping the
 * service in a child process also means a crashed channel cannot take the
 * plugin host down with it.
 *
 * Protocol: one JSON object per line on stdin/stdout. The first line carries
 * the settings, every later line is a command with an `id`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { startStandalone } from './packages/standalone/service.mjs'
import { catalogRows } from './models.mjs'
import { createConsoleHandoff } from './handoff.mjs'

let service
let handoff
let stopping
let stopped = false
let watch
let settings
let consoleRequests = Promise.resolve()
const lines = createInterface({ input: process.stdin })

const stop = () => {
  if (stopped) return stopping
  stopped = true
  clearInterval(watch)
  lines.close()
  stopping = (async () => {
    await Promise.allSettled([handoff?.close(), service?.close()])
  })().finally(() => process.exit(0))
  return stopping
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

/** Recover only this product's provably dead lock, never a live or unknown one. */
function recoverStaleLock(dataDir) {
  const lock = path.join(dataDir, 'service.lock')
  if (!fs.existsSync(lock)) return
  let previous
  try { previous = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch { return }
  if (previous?.product !== 'our-free-model-standalone') return
  if (!Number.isInteger(previous.pid) || previous.pid <= 0) return
  try { process.kill(previous.pid, 0) } catch (error) {
    if (error.code === 'ESRCH') fs.unlinkSync(lock)
  }
}

let started = false
lines.once('line', async line => {
  started = true
  try {
    settings = JSON.parse(line)
    recoverStaleLock(settings.dataDir)
    service = await startStandalone({
      dataDir: settings.dataDir,
      port: settings.port,
      refresh: settings.refresh !== false,
      logger: { info() {}, warn() {}, error() {} },
    })
    handoff = await createConsoleHandoff(service)
    if (process.stdin.readableEnded) return stop()
    process.stdout.write(`${JSON.stringify({
      type: 'ready', url: service.url, keyFile: service.keyFile, pid: process.pid,
    })}\n`)
    watch = setInterval(() => {
      try { process.kill(settings.parentPid, 0) } catch (error) {
        if (error.code === 'ESRCH') void stop()
      }
    }, 2000)
    watch.unref()
  } catch (error) {
    await Promise.allSettled([handoff?.close(), service?.close()])
    process.stdout.write(`${JSON.stringify({
      type: 'error',
      message: error.code === 'EEXIST'
        ? '数据目录已被另一个服务占用；关闭那个服务或使用另一个 managed.dataDir。'
        : `内置服务启动失败：${error.message}`,
    })}\n`)
    process.exit(1)
  }
})

lines.on('close', () => {
  if (started && service) void stop()
  else if (!started) process.exit(0)
})

lines.on('line', async line => {
  let command
  try { command = JSON.parse(line) } catch { return }
  if (!command.id || !service || stopping) return
  try {
    let value
    if (command.type === 'console') {
      value = await (consoleRequests = consoleRequests.catch(() => {}).then(async () => {
        if (stopping) throw new Error('内置服务正在关闭')
        return handoff.ticket()
      }))
    } else if (command.type === 'admit') {
      const model = command.model
      if (typeof model !== 'string' || model === '') throw new Error('Missing model')
      value = service.runtime.publicModelRows().some(row => row.id === model)
    } else if (command.type === 'models') {
      value = catalogRows(service.runtime)
    } else {
      throw new Error('Unknown managed command')
    }
    process.stdout.write(`${JSON.stringify({ id: command.id, value })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id: command.id,
      error: command.type === 'console' ? error.message : '内置服务无法执行管理请求',
    })}\n`)
  }
})
