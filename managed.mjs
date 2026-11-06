/**
 * The Magpie provider: one account, one provider, the standalone service's
 * whole catalog behind it.
 *
 * Magpie runs this module in its Bun plugin host. Nothing here imports the
 * standalone runtime; the child process in `runtime.mjs` owns it.
 */
import fs from 'node:fs'
import { getManagedRuntime } from './runtime.mjs'
import { PROVIDER, SDK, safeID, toMagpieModel } from './models.mjs'

let providerIcon

const fallback = models => {
  const out = { ...models }
  out[Symbol.for('magpie.fellBack')] = true
  return out
}

export async function createManagedPlugin(input, options = {}) {
  const runtime = getManagedRuntime(input, options)
  let cache

  const authorizeConsole = async () => {
    const url = await runtime.command('console')
    return {
      url,
      method: 'auto',
      instructions: '内置服务已启动。在本机控制台完成 EAC 或账号渠道登录，再回 Magpie 刷新模型。此按钮也可重新打开管理页面。',
      async callback() {
        return { type: 'success', key: 'managed', metadata: { dataDir: runtime.dataDir } }
      },
    }
  }
  const checkAuth = auth => {
    if (auth?.type !== 'api' || auth.key !== 'managed' || auth.metadata?.dataDir !== runtime.dataDir) {
      throw Object.assign(new Error('请在 Our Free Model 供应商中重新打开控制台并启用'), { signIn: 'expired' })
    }
  }

  async function discover(auth, previous = {}, signal) {
    checkAuth(auth)
    const conn = await runtime.connection()
    try {
      const rows = await runtime.command('models', {}, signal)
      const models = {}
      for (const row of rows) {
        const model = toMagpieModel(row, conn.base)
        if (model) models[model.id] = model
      }
      cache = models
      return models
    } catch (error) {
      signal?.throwIfAborted()
      if (error.signIn === 'expired') throw error
      return fallback(cache ?? previous)
    }
  }

  return {
    lifecycle: { dispose: () => runtime.dispose() },
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= { name: 'Our Free Model', npm: SDK, models: {} }
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 2,
      // Carry the packaged picture without depending on access to GitHub.
      icon: providerIcon ??= `data:image/svg+xml;base64,${fs.readFileSync(new URL('../icon.svg', import.meta.url)).toString('base64')}`,
      methods: [
        {
          type: 'oauth',
          label: '启用模型 / 打开账号管理控制台',
          authorize: () => authorizeConsole(),
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        checkAuth(auth)
        const conn = await runtime.connection()
        return {
          baseURL: conn.base,
          async fetch(input, init) {
            const currentAuth = await getAuth()
            checkAuth(currentAuth)
            const current = await runtime.connection()
            if (current.base !== conn.base) throw new Error('内置服务地址发生变化，请刷新或重载供应商')
            const request = new Request(input, init)
            if (request.method !== 'POST' || request.url !== `${conn.base}/chat/completions`) {
              throw new Error('Unsupported endpoint or method')
            }
            const body = await request.json()
            if (!body || typeof body !== 'object' || Array.isArray(body) || !safeID(body.model)) {
              throw new Error('Invalid chat request')
            }
            request.signal.throwIfAborted()
            if (!await runtime.command('admit', { model: body.model }, request.signal)) {
              return Response.json({
                error: {
                  type: 'invalid_request_error',
                  message: '模型不存在、已停用或没有可用账号；请在控制台检查并刷新模型',
                },
              }, { status: 404 })
            }
            request.signal.throwIfAborted()
            const headers = new Headers(request.headers)
            // The service authenticates with its own key; never forward the
            // gateway's credentials or a length that no longer matches.
            for (const name of ['authorization', 'cookie', 'host', 'content-length', 'connection', 'accept-encoding']) {
              headers.delete(name)
            }
            headers.set('content-type', 'application/json')
            headers.set('authorization', `Bearer ${current.key}`)
            // The service checks its live catalog on every request, so a stale
            // Magpie cache cannot re-enable a model disabled in the console.
            return fetch(`${current.base}/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: 'error',
            })
          },
        }
      },
      async usage(auth) {
        checkAuth(auth)
        await runtime.ensure()
        return {
          plan: 'Our Free Model；账号积分、用量、签到和请求日志见本机控制台',
          windows: [],
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        return discover(auth, provider.models)
      },
    },
  }
}
