import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventJournal } from '../observability.js'
import { beijing, buildReport, reportFilename } from '../report.js'

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-report-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const journal = new EventJournal(directory, { pluginVersion: '0.3.0', ...options })
  await journal.ready
  return { directory, journal }
}

test('weekly report keeps counts, versions and no paths or query text', async t => {
  const { directory, journal } = await setup(t)
  journal.record({ action: 'search', outcome: 'success', candidates: [{ name: 'passport-debug', kind: 'skill' }], matchCount: 1 })
  journal.record({ action: 'call', target: 'mcp__bosun__echo', kind: 'mcp', dispatched: true, outcome: 'success', durationMs: 12 })
  journal.record({ action: 'call', target: 'mcp__bosun__echo', kind: 'mcp', outcome: 'error', errorCode: 'invalid_arguments' })
  journal.record({ action: 'search', outcome: 'error', errorCode: 'not_found', matchCount: 0 })
  journal.record({ action: 'call', plugin: '0.2.8', target: 'mcp__bosun__old', kind: 'mcp', dispatched: true, outcome: 'success', durationMs: 5 })
  const summary = await journal.summary()
  const report = buildReport(summary)
  assert.match(report.markdown, /^# 能力网关周报/)
  assert.match(report.markdown, /运行插件版本：0\.3\.0/)
  assert.match(report.markdown, /调用成功率 \| 100\.0%/)
  assert.match(report.markdown, /实际转发 2，未转发 1/)
  assert.match(report.markdown, /搜索未命中 \| 1 \/ 2（50\.0%）/)
  assert.match(report.markdown, /兜底入口 \| 0 \/ 2/)
  assert.match(report.markdown, /样本少于 20 条/)
  assert.match(report.markdown, /\| 0\.2\.8 \|/)
  assert.match(report.markdown, /\| 0\.3\.0 \|/)
  assert.match(report.markdown, /invalid_arguments/)
  assert.ok(!report.markdown.includes(directory), 'report must not leak the log directory')
  assert.ok(!report.markdown.includes('/Users/'), 'report must not leak absolute paths')
  const parsed = JSON.parse(report.json)
  assert.equal(parsed.schema, 'capability-gateway/report@1')
  assert.equal(parsed.pluginVersion, '0.3.0')
  assert.deepEqual(parsed.byVersion.map(x => x.version), ['0.2.8', '0.3.0'])
  assert.equal(parsed.stats.calls, 3)
  assert.equal(parsed.stats.callSuccessRate, 1)
  assert.equal(parsed.stats.searchFallbacks, 0)
  assert.ok(!report.json.includes(directory))
})

test('an empty window reports missing samples instead of invented zeros', async t => {
  const { journal } = await setup(t)
  const report = buildReport(await journal.summary())
  assert.match(report.markdown, /窗口内没有搜索样本/)
  assert.match(report.markdown, /调用成功率 \| —/)
  const parsed = JSON.parse(report.json)
  assert.equal(parsed.stats.callSuccessRate, null)
  assert.equal(parsed.stats.searchCount, 0)
  assert.deepEqual(parsed.byVersion, [])
})

test('rows written by an older build keep an unknown version instead of inheriting the current one', async t => {
  const { directory, journal } = await setup(t)
  journal.record({ action: 'call', outcome: 'success', dispatched: true })
  await journal.flush()
  const day = (await readdir(directory)).find(x => x.endsWith('.jsonl'))
  const old = { version: 1, id: 'old-row', at: Date.now(), type: 'operation', action: 'call', agentId: null, callId: null,
    route: 'gateway', kind: 'mcp', target: null, actualTarget: null, outcome: 'success', errorCode: null, durationMs: 3,
    dispatched: true, routeMatches: null, candidates: [], matchCount: null, searchId: null, candidateRank: null }
  const raw = await readFile(join(directory, day), 'utf8')
  await writeFile(join(directory, day), `${raw}${JSON.stringify(old)}\n`)
  const summary = await new EventJournal(directory, { pluginVersion: '0.3.0' }).summary()
  assert.deepEqual(summary.byVersion.map(x => x.version), ['0.3.0', 'unknown'])
  const unknown = summary.byVersion.find(x => x.version === 'unknown')
  assert.equal(unknown.stats.calls, 1)
  assert.equal(summary.pluginVersion, '0.3.0')
})

test('report filename and rendering are deterministic in UTC+8', async t => {
  const { journal } = await setup(t)
  journal.record({ action: 'call', at: Date.UTC(2026, 9, 27, 16, 30), outcome: 'success', dispatched: true })
  const summary = await journal.summary()
  assert.equal(beijing(Date.UTC(2026, 9, 27, 16, 30)), '2026-10-28 00:30 (UTC+8)')
  assert.equal(reportFilename(summary, 'markdown'), 'capability-gateway-report-2026-10-28.md')
  assert.equal(reportFilename(summary, 'json'), 'capability-gateway-report-2026-10-28.json')
})
