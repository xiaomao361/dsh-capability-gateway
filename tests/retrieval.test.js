// Retrieval quality gate. The synthetic catalog below is generic on purpose:
// the shipped test must not depend on one machine's skills. A real snapshot can
// live in local/retrieval.json (gitignored, never packaged) and is evaluated
// with the same rules when present.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { rankCapabilities } from '../search.js'

const synthetic = [
  { name: 'release-notes', kind: 'skill', detail: 'Draft release notes from merged changes and labels.', keywords: ['发布说明', '变更记录'] },
  { name: 'sql-explain', kind: 'skill', detail: 'Explain a query plan and suggest indexes for slow queries.', keywords: ['执行计划', '索引', '慢查询'] },
  { name: 'i18n-audit', kind: 'skill', detail: 'Audit translation keys and find missing or unused strings.', keywords: ['国际化', '翻译', '本地化'] },
  { name: 'incident-triage', kind: 'skill', detail: 'Triage production incidents from alerts, timelines and dashboards.', keywords: ['告警', '故障', '时间线', '值班'] },
  { name: 'pdf-export', kind: 'skill', detail: 'Export documents to PDF with print layout and page breaks.', keywords: ['导出 PDF', '打印', '排版'] },
  { name: 'mcp__warehouse__query_table', kind: 'mcp', server: 'warehouse', detail: 'Run a read-only SQL query against the warehouse.' },
  { name: 'mcp__warehouse__list_tables', kind: 'mcp', server: 'warehouse', detail: 'List warehouse tables, columns and row counts.', keywords: ['表结构', '有哪些表'] },
  { name: 'mcp__ops__get_incident', kind: 'mcp', server: 'ops', detail: 'Fetch one incident with its timeline and owners.' },
  { name: 'mcp__ops__search_tools', kind: 'mcp', server: 'ops', detail: 'Search tools across all reachable services.' },
]
const syntheticTasks = [
  ['帮我写这次发布的说明', 'release-notes'],
  ['这条 SQL 为什么慢，执行计划看不懂', 'sql-explain'],
  ['检查翻译有没有漏的 key', 'i18n-audit'],
  ['线上告警了，帮我理一下时间线', 'incident-triage'],
  ['把这份报告导出成 PDF', 'pdf-export'],
  ['查一下仓库里有哪些表', 'mcp__warehouse__list_tables'],
  ['write release notes for this merge', 'release-notes'],
  ['explain this query plan and suggest an index', 'sql-explain'],
  ['the query plan looks off', 'sql-explain'],
  ['incident alert timeline for last night', 'mcp__ops__get_incident'],
]
const syntheticNegatives = ['loki logs', '把这份 Excel 拆成多个 sheet 并核对公式', '明天杭州天气怎么样']

const names = (catalog, query) => rankCapabilities(catalog, query).map(x => x.name)

function evaluate(catalog, tasks, negatives, label) {
  const firstMisses = tasks.filter(([query, expected]) => names(catalog, query)[0] !== expected)
  const topFiveMisses = tasks.filter(([query, expected]) => !names(catalog, query).slice(0, 5).includes(expected))
  const hit1 = (tasks.length - firstMisses.length) / tasks.length
  const hit5 = (tasks.length - topFiveMisses.length) / tasks.length
  assert.ok(hit5 >= 0.95, `${label} hit@5 ${hit5.toFixed(2)}; missed: ${topFiveMisses.map(([q]) => q).join(' | ')}`)
  assert.ok(hit1 >= 0.75, `${label} hit@1 ${hit1.toFixed(2)}; first miss: ${firstMisses.map(([q, e]) => `${q} -> ${names(catalog, q)[0]} (want ${e})`).join(' | ')}`)
  for (const query of negatives) {
    const picked = names(catalog, query)
    assert.deepEqual(picked, [], `${label} negative "${query}" returned ${picked.slice(0, 3).join(', ')}`)
  }
}

test('retrieval keeps a high hit rate over realistic wording', () => {
  evaluate(synthetic, syntheticTasks, syntheticNegatives, 'synthetic')
})

test('hit@5 rejects a target ranked sixth even when it exists in the full result', () => {
  const catalog = Array.from({ length: 6 }, (_, i) => ({ name: `archive-${i}`, detail: 'archive snapshots', kind: 'skill' }))
  assert.equal(names(catalog, 'archive')[5], 'archive-5')
  assert.throws(() => evaluate(catalog, [['archive', 'archive-5']], [], 'sixth'), /hit@5 0\.00/)
})

test('an unknown word no longer vetoes the whole query', () => {
  assert.equal(names(synthetic, 'the query plan looks off')[0], 'sql-explain')
  assert.ok(names(synthetic, 'alert timeline last night').length > 0)
})

test('a generic word cannot anchor an unrelated capability', () => {
  assert.ok(!names(synthetic, '帮我看看当前的服务').includes('mcp__ops__search_tools'))
})

test('aliases are what make a Chinese query reach an English description', () => {
  const bare = synthetic.map(({ keywords, ...rest }) => rest)
  assert.ok(!names(bare, '线上告警了，帮我理一下时间线').includes('incident-triage'))
  assert.equal(names(synthetic, '线上告警了，帮我理一下时间线')[0], 'incident-triage')
})

const localPath = fileURLToPath(new URL('../local/retrieval.json', import.meta.url))
test('local retrieval snapshot (skipped when absent)', { skip: !existsSync(localPath) }, async () => {
  const local = JSON.parse(await readFile(localPath, 'utf8'))
  evaluate(local.catalog, local.tasks, local.negatives, 'local')
})
