// Open-source guard: shipped code must not name a particular vendor, server or
// skill. Anything domain-specific belongs in per-install data (SKILL.md
// keywords, local packs, profile config), never in code or package defaults.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const SHIPPED_CODE = ['index.js', 'search.js', 'validation.js', 'observability.js', 'remote.js', 'report.js', 'client.js']
const VENDOR = /\b(bosun|grafana|metabase|purser|claracore|volcengine|folotoy|passport|dreamina|typesafe|atlas|census)\b/gi
// Comments explain past regressions by name; only executable text is scanned.
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('shipped code names no vendor, server or private skill', async () => {
  for (const file of SHIPPED_CODE) {
    const code = stripComments(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'))
    const found = [...new Set([...code.matchAll(VENDOR)].map(match => match[0]))]
    assert.deepEqual(found, [], `${file} hardcodes ${found.join(', ')}`)
  }
})

test('the published package never carries per-install data', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const entry of pkg.files) {
    if (entry === 'docs/DESIGN.md') continue // the published behaviour contract
    assert.ok(!/^(local|work|tests?|docs?)\//.test(entry), `package.json files must not ship ${entry}`)
  }
})

test('the package patch ships no install-specific scope', async () => {
  const { parse } = await import('yaml')
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal(VENDOR.test(text), false, 'the default patch must not name an install-specific server')
  const config = parse(text)[0].insert[0].config
  assert.deepEqual(config.skillRoots, [], 'skill roots are install data, not package defaults')
  assert.deepEqual(config.mcpServers, [], 'managed servers are install data, not package defaults')
})
