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

test('alias edits append under the host revision lock and preserve scope', async () => {
  const fiber = { uid: 1 }
  const entry = { fiber, options: { config: { skillRoots: ['/fixture'], skillKeywords: { workflow: ['旧别名'] } } } }
  const editor = { entries: () => [entry], async edit(_entry, update) {
    entry.options.config = update(entry.options.config)
  } }
  const service = createManagement({ fiber, get: () => editor }, { skillRoots: ['/fixture'], mcpServers: [] }, value => value)
  const revision = service.snapshot({ skills: [] }).revision
  await service.addAlias({ revision, kind: 'skill', name: 'workflow', word: ' 新别名 ' })
  assert.deepEqual(entry.options.config, { skillRoots: ['/fixture'], skillKeywords: { workflow: ['旧别名', '新别名'] } })
  await assert.rejects(service.addAlias({ revision, kind: 'skill', name: 'workflow', word: '其他词' }), /conflict/)
  assert.deepEqual(entry.options.config.skillKeywords.workflow, ['旧别名', '新别名'])
})

test('alias edits reject malformed existing maps with invalid_config and measure Unicode code points', async () => {
  const fiber = { uid: 1 }
  const entry = { fiber, options: { config: { skillKeywords: { workflow: 'not-an-array' } } } }
  const editor = { entries: () => [entry], async edit(_entry, update) {
    entry.options.config = update(entry.options.config)
  } }
  const service = createManagement({ fiber, get: () => editor }, { skillRoots: [], mcpServers: [] }, value => value)
  await assert.rejects(
    service.addAlias({ revision: service.snapshot({ skills: [] }).revision, kind: 'skill', name: 'workflow', word: '别名' }),
    /invalid_config/,
  )
  entry.options.config = { skillKeywords: {} }
  const revision = service.snapshot({ skills: [] }).revision
  const eighty = '🚀'.repeat(80)
  await service.addAlias({ revision, kind: 'skill', name: 'workflow', word: eighty })
  assert.deepEqual(entry.options.config.skillKeywords.workflow, [eighty])
  await assert.rejects(
    service.addAlias({ revision: service.snapshot({ skills: [] }).revision, kind: 'skill', name: 'workflow', word: '🚀'.repeat(81) }),
    /invalid_arguments/,
  )
})
