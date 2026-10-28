import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventJournal, projectEvent } from '../observability.js'

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-journal-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const journal = new EventJournal(directory)
  await journal.ready
  return { directory, journal }
}

test('journal persists only allowlisted metadata and survives reload', async t => {
  const { directory, journal } = await setup(t)
  journal.record({ action: 'call', dispatched: true, kind: 'mcp', target: 'mcp__bosun__x', actualTarget: 'mcp__bosun__x', outcome: 'success', durationMs: 12,
    query: 'private query', arguments: { token: 'secret' }, result: 'private result', error: 'private error' })
  await journal.flush()
  const restored = await new EventJournal(directory).snapshot()
  assert.equal(restored.stats.calls, 1)
  assert.equal(restored.stats.callSuccessRate, 1)
  const name = (await readdir(directory)).find(x => x.endsWith('.jsonl'))
  const raw = await readFile(join(directory, name), 'utf8')
  assert.ok(!/private|secret|token|arguments/.test(raw))
  assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600)
})

test('denominators distinguish no samples, cancellations, misses and unlinked selections', async t => {
  const { journal } = await setup(t)
  assert.equal((await journal.snapshot()).stats.callSuccessRate, null)
  journal.record({ action: 'search', matchCount: 0, outcome: 'error', errorCode: 'not_found' })
  journal.record({ action: 'call', dispatched: true, outcome: 'success' })
  journal.record({ action: 'call', dispatched: true, outcome: 'cancelled' })
  journal.record({ action: 'call', dispatched: true, outcome: 'error' })
  journal.record({ action: 'load', outcome: 'success', searchId: 'search-id', candidateRank: 0 })
  journal.record({ action: 'load', outcome: 'success', searchId: 'search-id', candidateRank: 1 })
  const { stats } = await journal.snapshot()
  assert.equal(stats.callSuccessRate, 1 / 3)
  assert.equal(stats.searchMisses, 1)
  assert.equal(stats.candidateAdoptionRate, 1 / 2)
  assert.equal(stats.explicitOrUnlinked, 3)
})

test('filtering event list does not silently change summary denominator', async t => {
  const { journal } = await setup(t)
  journal.record({ agentId: 'a', action: 'call', dispatched: true, outcome: 'success' })
  journal.record({ agentId: 'a', action: 'call', dispatched: true, outcome: 'error' })
  journal.record({ agentId: 'b', action: 'call', dispatched: true, outcome: 'success' })
  const result = await journal.snapshot({ agentId: 'a', outcome: 'error' })
  assert.equal(result.events.length, 1)
  assert.equal(result.stats.calls, 2)
  assert.equal(result.stats.callSuccessRate, 0.5)
})

test('invalid journal line preserves partial/incomplete state', async t => {
  const { directory, journal } = await setup(t)
  journal.record({ action: 'call', dispatched: true, outcome: 'success' })
  await journal.flush()
  const file = (await readdir(directory)).find(x => x.endsWith('.jsonl'))
  const content = await readFile(join(directory, file), 'utf8')
  await writeFile(join(directory, file), content + '{broken\n')
  const result = await new EventJournal(directory).snapshot()
  assert.equal(result.stats.calls, 1)
  assert.equal(result.storage.complete, false)
  assert.equal(result.storage.invalidLines, 1)
})

test('write failure is observable, keeps the call outcome, and failed review is explicit', async t => {
  const { directory } = await setup(t)
  const file = join(directory, 'not-a-directory')
  await writeFile(file, 'fixture')
  const journal = new EventJournal(file)
  const id = journal.record({ action: 'call', dispatched: true, outcome: 'success' })
  const result = await journal.snapshot()
  assert.equal(result.stats.callSuccesses, 1)
  assert.equal(result.storage.complete, false)
  assert.ok(result.storage.writeError)
  await assert.rejects(journal.review(id, 'wrong'), /not persisted/)
})

test('manual review updates are persistent and never fabricate automatic correctness', async t => {
  const { directory, journal } = await setup(t)
  const id = journal.record({ action: 'call', dispatched: true, outcome: 'success' })
  assert.equal((await journal.snapshot()).stats.reviewedCorrect, 0)
  await journal.review(id, 'correct')
  await journal.review(id, 'wrong')
  assert.equal((await new EventJournal(directory).snapshot()).stats.reviewedWrong, 1)
  assert.equal((await journal.snapshot()).stats.reviewedCorrect, 0)
  await assert.rejects(journal.review('missing', 'correct'), /not_found/)
  await assert.rejects(journal.review(id, 'maybe'), /invalid_arguments/)
})

test('event projection removes arbitrary text even when restored from disk', () => {
  const event = projectEvent({ action: 'raw prompt text', target: 'has spaces and sensitive text', candidates: [{ name: 'mcp__a__b', kind: 'mcp', description: 'secret' }],
    outcome: 'unknown', durationMs: -5, errorCode: 'private error detail' })
  assert.equal(event.action, 'invalid')
  assert.equal(event.target, null)
  assert.equal(event.outcome, 'error')
  assert.equal(event.durationMs, null)
  assert.equal(event.errorCode, null)
  assert.ok(!JSON.stringify(event).includes('secret'))
})

test('well-formed JSON with an unknown result state is incomplete data, not a failed-call sample', async t => {
  const { directory, journal } = await setup(t)
  journal.record({ action: 'call', dispatched: true, outcome: 'success' })
  await journal.flush()
  const file = (await readdir(directory)).find(x => x.endsWith('.jsonl'))
  const raw = await readFile(join(directory, file), 'utf8')
  await writeFile(join(directory, file), raw + JSON.stringify({ version: 1, id: 'bad-state', at: Date.now(), type: 'operation', action: 'call', dispatched: true, route: 'gateway', outcome: 'unknown' }) + '\n')
  const result = await new EventJournal(directory).snapshot()
  assert.equal(result.stats.calls, 1)
  assert.equal(result.storage.invalidLines, 1)
  assert.equal(result.storage.complete, false)
})

test('a later successful write cannot erase evidence of a missing persisted event', async t => {
  const { directory } = await setup(t)
  const path = join(directory, 'journal')
  const journal = new EventJournal(path)
  await journal.ready
  await writeFile(path, 'obstruction')
  journal.record({ action: 'call', dispatched: true, outcome: 'success' })
  await journal.flush()
  await rm(path)
  journal.record({ action: 'call', dispatched: true, outcome: 'success' })
  const result = await journal.snapshot()
  assert.equal(result.storage.writeError, null)
  assert.equal(result.storage.writeFailures, 1)
  assert.equal(result.storage.complete, false)
  assert.equal(result.stats.calls, 2)
})

test('pagination reaches records beyond the old 100-record window without duplicates', async t => {
  const { journal } = await setup(t)
  for (let index = 0; index < 207; index++) journal.record({ id: `paged-${index}`, agentId: 'a', action: 'call', dispatched: true, outcome: index % 2 ? 'error' : 'success' })
  const first = await journal.snapshot({ limit: 10 })
  assert.equal(first.total, 207)
  assert.equal(first.anchorId, 'paged-206')
  assert.equal(first.offset, 0)
  const ids = []
  for (let offset = 0; offset < first.total; offset += 10) {
    const page = await journal.snapshot({ limit: 10, offset, anchorId: first.anchorId })
    ids.push(...page.events.map(row => row.id))
    assert.deepEqual(page.stats, first.stats)
  }
  assert.deepEqual(ids, Array.from({ length: 207 }, (_, index) => `paged-${206 - index}`))
  const last = await journal.snapshot({ limit: 10, offset: 10000, anchorId: first.anchorId })
  assert.equal(last.offset, 200)
  assert.equal(last.events.length, 7)
})

test('an anchored page stays stable when calls arrive, filters and reviews preserve denominators', async t => {
  const { journal } = await setup(t)
  for (let index = 0; index < 27; index++) journal.record({ id: `stable-${index}`, agentId: index % 3 ? 'a' : 'b', action: 'call', dispatched: true, outcome: index % 2 ? 'error' : 'success' })
  const first = await journal.snapshot({ agentId: 'a', outcome: 'error', limit: 3 })
  const before = await journal.snapshot({ agentId: 'a', outcome: 'error', limit: 3, offset: 3, anchorId: first.anchorId })
  journal.record({ id: 'arrived', agentId: 'a', action: 'call', dispatched: true, outcome: 'error' })
  await journal.review(before.events[0].id, 'wrong')
  const after = await journal.snapshot({ agentId: 'a', outcome: 'error', limit: 3, offset: 3, anchorId: first.anchorId })
  assert.deepEqual(after.events.map(row => row.id), before.events.map(row => row.id))
  assert.equal(after.events[0].verdict, 'wrong')
  assert.equal(after.total, first.total)
  assert.equal(after.stats.calls, first.stats.calls + 1)
  assert.equal(after.stats.reviewedWrong, 1)
  assert.equal((await journal.snapshot({ agentId: 'a', outcome: 'error', limit: 3 })).events[0].id, 'arrived')
})

test('expired or cross-scope anchors are explicit failures rather than empty successful pages', async t => {
  const { journal } = await setup(t)
  const at = Date.now()
  journal.record({ id: 'older-anchor', at, agentId: 'a', action: 'call', dispatched: true, outcome: 'success' })
  journal.record({ id: 'other-scope', at, agentId: 'b', action: 'call', dispatched: true, outcome: 'success' })
  await assert.rejects(journal.snapshot({ agentId: 'b', anchorId: 'older-anchor' }), /not_found: history anchor expired/)
  journal.now = () => at + 8 * 86400000
  await assert.rejects(journal.snapshot({ anchorId: 'older-anchor' }), /not_found: history anchor expired/)
  const fresh = await journal.snapshot({ offset: 50, limit: 10 })
  assert.equal(fresh.total, 0)
  assert.equal(fresh.offset, 0)
  assert.equal(fresh.anchorId, null)
  assert.equal(fresh.stats.callSuccessRate, null)
})

test('10,000 retained-event query keeps a bounded response and the original summary meaning', async t => {
  const { journal } = await setup(t)
  const at = Date.now()
  journal.rows = Array.from({ length: 10000 }, (_, index) => projectEvent({ id: `volume-${index}`, at, action: 'call', dispatched: true, outcome: index % 2 ? 'error' : 'success' }))
  const page = await journal.snapshot({ offset: 9990, limit: 10 })
  assert.equal(page.events.length, 10)
  assert.equal(page.events.at(-1).id, 'volume-0')
  assert.equal(page.total, 10000)
  assert.equal(page.stats.calls, 10000)
  assert.equal(page.stats.callSuccessRate, 0.5)
  const filtered = await journal.snapshot({ outcome: 'error', offset: 4990, limit: 10, anchorId: page.anchorId })
  assert.equal(filtered.total, 5000)
  assert.equal(filtered.events.length, 10)
  assert.deepEqual(filtered.stats, page.stats)
})

test('rejected calls stay observable without counting as MCP failures', async t => {
  const { journal } = await setup(t)
  journal.record({ action: 'call', outcome: 'success', dispatched: true })
  journal.record({ action: 'call', outcome: 'error', errorCode: 'invalid_arguments' })
  journal.record({ action: 'call', outcome: 'error', errorCode: 'unavailable' })
  const { stats } = await journal.snapshot()
  assert.equal(stats.calls, 3)
  assert.equal(stats.callDispatched, 1)
  assert.equal(stats.callRejected, 2)
  assert.equal(stats.callErrors, 2)
  assert.equal(stats.callSuccessRate, 1)
  assert.equal((await journal.snapshot()).stats.callSuccessRate, 1)
})
