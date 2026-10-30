import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { z } from 'zod'
import * as gateway from '../index.js'
import { descriptors } from '../remote.js'
import { loadRuntime, loadBrowserRuntime } from './runtime.js'

const [hostRuntime, browser] = await Promise.all([loadRuntime(), loadBrowserRuntime()])
after(async () => {
  for (const runtime of [hostRuntime, browser]) if (runtime.extracted) await rm(runtime.extracted, { recursive: true, force: true })
})

async function setup(t) {
  const logDir = await mkdtemp(join(tmpdir(), 'gateway-boot-log-fixture-'))
  const host = new hostRuntime.Context()
  const client = new browser.Context()
  t.after(async () => { await client.fiber.dispose(); await host.fiber.dispose(); await rm(logDir, { recursive: true, force: true }) })
  for (const service of [hostRuntime.SystemPrompt, hostRuntime.ToolRuntime, hostRuntime.SkillRegistry, hostRuntime.TypertRegistry]) await host.plugin(service, {}).await()
  await host.plugin({ apply(ctx) { ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'policy' }) }) } }).await()
  await host.plugin(hostRuntime.TypertGateway, {}).await()
  await host.plugin(gateway, { wrapSkills: false, wrapMcp: false, logDir, localAliases: false }).await()
  const peer = new hostRuntime.Peer(host, { principal: { kind: 'owner' }, interactions: 'none' })
  const registrations = new Map()
  let styles = 0
  const calls = []
  class Slots extends browser.Service {
    constructor(ctx) { super(ctx, 'slots') }
    inject(name, install) { return this.ctx.effect(install) }
    register(row, component) {
      return this.ctx.effect(() => {
        assert.ok(!registrations.has(row.id), 'settings tab must not register twice')
        registrations.set(row.id, { ...row, component })
        return () => registrations.delete(row.id)
      })
    }
  }
  await client.plugin(hostRuntime.TypertRegistry).await()
  await client.plugin(Slots).await()
  await client.plugin({ apply(ctx) {
    ctx.provide('connection', { interactions: 'none', generation: { getSnapshot: () => undefined },
      rpc: { open() {}, async call(channel, endpoint, payload, signal) {
        assert.equal(channel, '/api'); calls.push({ endpoint, payload })
        return host.get('typertGateway').invokeRpc(endpoint, payload, signal, peer)
      } },
    })
  } }).await()
  await client.plugin(browser.ClientRemote).await()
  let declaration
  runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(row) { declaration = row } } }, console,
    document: {
      createElement: () => ({ dataset: {}, remove() { styles-- } }),
      head: { appendChild() { styles++ } },
    },
  })
  const plugin = declaration.factory(name => name === 'react' ? React : name === 'zod' ? { z } : assert.fail(`unexpected request ${name}`))
  return { client, host, plugin, registrations, calls, styles: () => styles }
}

test('native Client Remote rejects the old src-json contribution that broke web boot', async t => {
  const f = await setup(t)
  const old = descriptors.map(descriptor => ({ ...descriptor,
    parameters: descriptor.parameters.map(parameter => ({ ...parameter, codec: { mode: 'src-json' }, strictCodec: { mode: 'src-json' } })),
  }))
  const broken = f.client.plugin({ inject: ['remote'], async apply(ctx) {
    await ctx.remote.$mount({ package: 'broken-boot-fixture', descriptors: old })
  } })
  await assert.rejects(broken.await(), /has no strict codec/)
  assert.equal(broken.state, 3)
})

test('native Client plugin activates, registers its tab, calls Host and fully unloads/reloads', async t => {
  const f = await setup(t)
  for (let generation = 0; generation < 2; generation++) {
    const plugin = f.client.plugin(f.plugin)
    await plugin.await()
    assert.equal(plugin.state, 2)
    const tab = f.registrations.get('capability-gateway')
    assert.ok(tab, 'tab must exist after boot, without rendering any page')
    assert.equal(tab.name, 'settings.plugins.tab')
    assert.equal(tab.label(), '能力网关')
    assert.equal(f.styles(), 1)
    const api = tab.inject().api
    const snapshot = await api.snapshot({ historyScope: 'all', limit: 10, offset: 100 })
    assert.equal(snapshot.inventory.scope, 'host-only')
    assert.equal(snapshot.activity.stats.callSuccessRate, null)
    assert.equal(snapshot.activity.offset, 0)
    assert.equal(snapshot.activity.limit, 10)
    assert.equal(snapshot.activity.anchorId, null)
    assert.equal(f.calls.at(-1).endpoint, 'capabilityGateway/snapshot')
    const before = f.calls.length
    await assert.rejects(api.snapshot({ outcome: 'invalid' }), /invalid|Invalid|expected/)
    assert.equal(f.calls.length, before + 1, 'Host strict input codec must reject invalid wire arguments')
    await assert.rejects(api.snapshot({ offset: -1 }), /invalid|Invalid|expected|Too small/)
    await assert.rejects(api.snapshot({ anchorId: 'expired-fixture' }), /not_found|internal/)
    await assert.rejects(api.review({ eventId: 'missing', verdict: 'wrong' }), /not_found|internal/)
    const report = await api.report({ format: 'json' })
    assert.equal(JSON.parse(report.content).schema, 'capability-gateway/report@1')
    assert.equal(f.calls.at(-1).endpoint, 'capabilityGateway/report')
    const markdown = await api.report({})
    assert.match(markdown.content, /# 能力网关周报/)
    assert.match(markdown.filename, /\.md$/)
    await assert.rejects(api.report({ format: 'pdf' }), /invalid|Invalid|expected/)
    await assert.rejects(api.report({ historyScope: 'selected' }), /invalid_arguments|internal/)
    await assert.rejects(api.report({ historyScope: 'selected', agentId: 'gone' }), /not_found|internal/)
    await assert.rejects(api.report({ historyScope: 'bad' }), /invalid|Invalid|expected/)
    await plugin.dispose()
    assert.equal(f.registrations.size, 0)
    assert.equal(f.styles(), 0)
    assert.equal(f.client.get('remote.capabilityGateway'), undefined)
  }
})
