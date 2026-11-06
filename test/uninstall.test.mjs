/**
 * Uninstall cleanup and installation registration.
 *
 * All directories are temporary; no real Magpie data or service is touched.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  cleanupInstallation, registerInstallation, validateDataDir,
} from '../installation-state.mjs'

const scratchDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-uninstall-')))

function layout(t) {
  const scratch = scratchDir()
  const directory = path.join(scratch, 'magpie')
  const dataDir = path.join(directory, 'our-free-model')
  fs.mkdirSync(directory, { recursive: true })
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  return { directory, dataDir }
}

function seed(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'runtime', 'node-v24.21.0-darwin-arm64', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'runtime', 'node-v24.21.0-darwin-arm64', 'bin', 'node'), '')
  fs.mkdirSync(path.join(dataDir, 'clients', 'codex'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'clients', 'codex', 'config.toml'), '')
  fs.mkdirSync(path.join(dataDir, 'subscriptions'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'subscriptions', 'index.json'), '{}')
  fs.mkdirSync(path.join(dataDir, 'channel-pack'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'channel-pack', 'settings.yaml'), '')
  for (const file of ['settings.json', 'stats.json', 'availability.json', 'catalog.json', 'workbench.json']) {
    fs.writeFileSync(path.join(dataDir, file), '{}')
  }
  fs.writeFileSync(path.join(dataDir, 'keep.txt'), 'user file')
  fs.mkdirSync(path.join(dataDir, 'keepdir'))
  fs.writeFileSync(path.join(dataDir, 'keepdir', 'note.txt'), 'user dir')
}

test('register then clean removes only owned entries and the registration', async t => {
  const { directory, dataDir } = layout(t)
  await registerInstallation(directory, dataDir)
  assert.ok(fs.existsSync(path.join(directory, 'dsh-our-free-model-magpie-owned.json')))
  assert.ok(fs.existsSync(path.join(dataDir, '.dsh-ofm-magpie-owner.json')))
  seed(dataDir)
  fs.writeFileSync(path.join(directory, 'plugin-auth.json'), JSON.stringify({
    'our-free-model': { type: 'api', key: 'managed' },
    'our-free-model#abc123': { type: 'api', key: 'managed' },
    other: { type: 'api', key: 'keep' },
  }))

  await cleanupInstallation({ directory }, { dataDir })

  for (const name of ['settings.json', 'stats.json', 'availability.json', 'catalog.json', 'workbench.json',
    'runtime', 'clients', 'subscriptions', 'channel-pack', '.dsh-ofm-magpie-owner.json']) {
    assert.equal(fs.existsSync(path.join(dataDir, name)), false, `${name} should be removed`)
  }
  assert.equal(fs.readFileSync(path.join(dataDir, 'keep.txt'), 'utf8'), 'user file')
  assert.ok(fs.existsSync(path.join(dataDir, 'keepdir', 'note.txt')))
  assert.equal(fs.existsSync(path.join(directory, 'dsh-our-free-model-magpie-owned.json')), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'plugin-auth.json'), 'utf8')), {
    other: { type: 'api', key: 'keep' },
  })
})

test('the default uninstall entry adopts managed options', async t => {
  const { directory, dataDir } = layout(t)
  await registerInstallation(directory, dataDir)
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ forwardKey: 'k', standalonePort: 1 }))
  const { default: uninstall } = await import('../uninstall.mjs')
  await uninstall({ directory }, { managed: { dataDir } })
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false)
  assert.equal(fs.existsSync(path.join(dataDir, '.dsh-ofm-magpie-owner.json')), false)
})

test('a data directory owned by another installation is refused', async t => {
  const { directory, dataDir } = layout(t)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, '.dsh-ofm-magpie-owner.json'),
    JSON.stringify({ product: 'someone-else', directory, realPath: dataDir, token: 'x' }))
  await assert.rejects(registerInstallation(directory, dataDir), /另一个安装实例/)
})

test('an unreadable service lock stops cleanup before deleting anything', async t => {
  const { directory, dataDir } = layout(t)
  await registerInstallation(directory, dataDir)
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}')
  fs.writeFileSync(path.join(dataDir, 'service.lock'), JSON.stringify({ product: 'unknown', pid: 1 }))
  await assert.rejects(cleanupInstallation({ directory }, { dataDir }), /服务锁无法确认归属/)
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')))
  assert.ok(fs.existsSync(path.join(dataDir, '.dsh-ofm-magpie-owner.json')))
})

test('a corrupted registry aborts cleanup without touching data', async t => {
  const { directory, dataDir } = layout(t)
  await registerInstallation(directory, dataDir)
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}')
  fs.writeFileSync(path.join(directory, 'dsh-our-free-model-magpie-owned.json'), '{"product":"other"}')
  await assert.rejects(cleanupInstallation({ directory }, { dataDir }), /清理登记不完整/)
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')))
})

test('protected data directories are rejected', () => {
  const home = os.homedir()
  assert.throws(() => validateDataDir(home, home), /专用的子目录/)
  assert.throws(() => validateDataDir(path.parse(home).root, home), /专用的子目录/)
  assert.throws(() => validateDataDir(home, home), /专用的子目录/)
})
