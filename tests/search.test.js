import test from 'node:test'
import assert from 'node:assert/strict'
import { rankCapabilities } from '../search.js'

test('a multi-term query needs two real matches, and one known term is enough alone', () => {
  const candidates = [
    { name: 'first', detail: 'alpha beta', kind: 'skill' },
    { name: 'second', detail: 'gamma', kind: 'skill' },
    { name: 'third', detail: 'delta', kind: 'skill' },
  ]
  // No document carries two of the three topics.
  assert.deepEqual(rankCapabilities(candidates, 'alpha gamma delta'), [])
  // A two-topic query is not satisfied by one topic: one incidental word must
  // not decide which capability is suggested.
  assert.deepEqual(rankCapabilities(candidates, 'alpha gamma'), [])
  assert.deepEqual(rankCapabilities(candidates, 'alpha').map(x => x.name), ['first'])
  assert.deepEqual(rankCapabilities(candidates, 'alpha beta').map(x => x.name), ['first'])
  // An unknown word no longer vetoes the query; the single known term carries it.
  assert.deepEqual(rankCapabilities(candidates, 'alpha unknown').map(x => x.name), ['first'])
  assert.deepEqual(rankCapabilities(candidates, 'unknown gamma delta'), [])
  const anchored = [
    { name: 'mcp__catalog__search_tools', detail: 'Search registered tools', keywords: ['grafana'], kind: 'mcp' },
    { name: 'passport-debug', detail: 'Diagnose device failures from logs', kind: 'skill' },
  ]
  assert.deepEqual(rankCapabilities(anchored, 'grafana logs').map(x => x.name), ['mcp__catalog__search_tools'])
  assert.deepEqual(rankCapabilities(anchored, 'metabase logs'), [])
})

test('generic task words are not searchable signal on their own', () => {
  const candidates = [
    { name: 'debug-logs', detail: 'Diagnose runtime failures from logs and stack faults', kind: 'skill' },
    { name: 'page-layout', detail: 'Layout structure for web pages', kind: 'skill' },
  ]
  assert.deepEqual(rankCapabilities(candidates, 'logs'), [])
  assert.deepEqual(rankCapabilities(candidates, 'errors'), [])
  assert.deepEqual(rankCapabilities(candidates, 'page logs'), [])
})
