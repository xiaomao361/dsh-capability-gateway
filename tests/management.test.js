import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagement } from '../management.js'

test('scope persistence failures and expression configs never become successful saves', async () => {
  const fiber = { uid: 1 }
  const entry = { fiber, options: { config: { skillRoots: [], mcpServers: [], maxResults: 7 } } }
  let writes = 0
  const editor = { entries: () => [entry], async edit(_entry, change) {
    change(structuredClone(entry.options.config))
    writes++
    throw new Error('disk unavailable')
  } }
  const service = createManagement({ fiber, get: () => editor }, { skillRoots: [], mcpServers: [] }, value => value)
  const revision = service.snapshot({ skills: [] }).revision
  await assert.rejects(service.save({ revision, skillRoots: [], mcpServers: ['fixture'] }), /disk unavailable/)
  assert.equal(writes, 1)
  assert.deepEqual(entry.options.config.mcpServers, [])
  entry.options.config = { __jsExpr: 'fixture-expression' }
  await assert.rejects(service.save({ revision: service.snapshot({ skills: [] }).revision, skillRoots: [], mcpServers: [] }), /表达式配置/)
  assert.equal(writes, 1)
})

test('scope updates cannot target another plugin entry or leak its configuration', async () => {
  let writes = 0
  const editor = { entries: () => [{ fiber: { uid: 2 }, options: { config: { secret: 'fixture-secret' } } }], async edit() { writes++ } }
  const service = createManagement({ fiber: { uid: 1 }, get: () => editor }, { skillRoots: [], mcpServers: [] }, value => value)
  const snapshot = service.snapshot({ skills: [] })
  assert.equal(snapshot.writable, false)
  assert.ok(!JSON.stringify(snapshot).includes('fixture-secret'))
  await assert.rejects(service.save({ revision: 'other', skillRoots: [], mcpServers: [] }), /unavailable/)
  assert.equal(writes, 0)
})
