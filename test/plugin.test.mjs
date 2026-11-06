/**
 * Offline acceptance for the Magpie host entry.
 *
 * Starts the real standalone service with refresh disabled, so no vendor is
 * contacted. The management handoff and the forwarding boundary are exercised
 * end to end.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { catalogRow, toMagpieModel } from '../models.mjs'

test('model rows keep the service metadata and drop unsafe ids', () => {
  assert.equal(toMagpieModel({ id: '__proto__' }, 'http://127.0.0.1:1/v1'), undefined)
  const model = toMagpieModel({
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash',
    vision: true,
    context_window: 128000,
    max_tokens: 64000,
    reasoning: true,
    reasoning_efforts: ['low', 'high', null, '__proto__'],
  }, 'http://127.0.0.1:1/v1')
  assert.equal(model.providerID, 'our-free-model')
  assert.equal(model.api.url, 'http://127.0.0.1:1/v1')
  assert.equal(model.limit.context, 128000)
  assert.equal(model.limit.output, 64000)
  assert.equal(model.capabilities.reasoning, true)
  assert.equal(model.capabilities.input.image, true)
  assert.deepEqual(Object.keys(model.variants), ['low', 'high'])
})

test('catalog rows fall back to the entry capabilities', () => {
  const row = catalogRow({
    id: 'kilo-auto/free',
    name: '',
    vision: false,
    reasoning: true,
    contextWindow: 262144,
    maxOutput: 131072,
  })
  assert.equal(row.name, 'kilo-auto/free')
  assert.equal(row.context_window, 262144)
  assert.equal(row.max_tokens, 131072)
  assert.equal(row.reasoning, true)
  assert.ok(Array.isArray(row.reasoning_efforts))
})

test('plugin starts the service, opens the console and refuses unknown models', async t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-host-')))
  const dataDir = path.join(scratch, 'data')
  const { OurFreeModelPlugin } = await import('../index.mjs')
  const hooks = await OurFreeModelPlugin(
    { directory: scratch, worktree: scratch },
    { managed: { dataDir, port: 0, refresh: false, nodePath: process.execPath, autoInstallNode: false } },
  )
  t.after(async () => {
    await hooks.lifecycle.dispose()
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider['our-free-model'].name, 'Our Free Model')

  const authorize = await hooks.auth.methods[0].authorize()
  assert.match(authorize.url, /^http:\/\/127\.0\.0\.1:\d+\/open\/[A-Za-z0-9_-]+$/)
  assert.equal(authorize.method, 'auto')

  const result = await authorize.callback()
  assert.equal(result.type, 'success')
  assert.equal(result.metadata.dataDir, dataDir)

  // The handoff exchanges the local key for the console cookie and lands on
  // the management page, without the key ever appearing in the URL.
  const page = await fetch(authorize.url, { redirect: 'follow' })
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  await page.body?.cancel()

  const auth = { type: 'api', key: 'managed', metadata: { dataDir } }
  const models = await hooks.provider.models({ models: {} }, { auth })
  assert.equal(typeof models, 'object')
  assert.equal(models[Symbol.for('magpie.fellBack')], undefined)
  // Starting the service registers ownership so Magpie's uninstall can find it.
  assert.ok(fs.existsSync(path.join(dataDir, '.dsh-ofm-magpie-owner.json')))
  assert.ok(fs.existsSync(path.join(scratch, 'dsh-our-free-model-magpie-owned.json')))

  const loader = await hooks.auth.loader(async () => auth)
  assert.match(loader.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  const refused = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(refused.status, 404)
  const error = await refused.json()
  assert.equal(error.error.type, 'invalid_request_error')

  await assert.rejects(
    hooks.auth.loader(async () => ({ type: 'api', key: 'managed', metadata: { dataDir: '/elsewhere' } })),
  )
})

test('a listed model is published and its stream is forwarded', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/inference/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }] }))
      return
    }
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      assert.equal(body.model, 'mimo-v2.6-flash-free')
      assert.match(req.headers['user-agent'] ?? '', /^opencode\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[a-z0-9-]+$/i)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'host-ok' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''))
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${upstream.address().port}`
  process.env.OUR_FREE_MODEL_BASE = base
  process.env.OUR_FREE_MODEL_KILO_BASE = base

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-stream-')))
  const dataDir = path.join(scratch, 'data')
  const { OurFreeModelPlugin } = await import('../index.mjs')
  const hooks = await OurFreeModelPlugin(
    { directory: scratch, worktree: scratch },
    { managed: { dataDir, port: 0, nodePath: process.execPath, autoInstallNode: false } },
  )
  t.after(async () => {
    await hooks.lifecycle.dispose()
    delete process.env.OUR_FREE_MODEL_BASE
    delete process.env.OUR_FREE_MODEL_KILO_BASE
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  const authorize = await hooks.auth.methods[0].authorize()
  const auth = (await authorize.callback()).key
  const account = { type: 'api', key: auth, metadata: { dataDir } }
  const models = await hooks.provider.models({ models: {} }, { auth: account })
  assert.ok(models['mimo-v2.6-flash-free'], 'listed model is published')
  assert.equal(models['mimo-v2.6-flash-free'].providerID, 'our-free-model')

  const loader = await hooks.auth.loader(async () => account)
  const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.6-flash-free',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /host-ok/)
  assert.match(text, /\[DONE\]/)
})
