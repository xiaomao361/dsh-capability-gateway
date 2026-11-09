import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { z } from 'zod'
import { renderToStaticMarkup } from 'react-dom/server'
import TestRenderer, { act } from 'react-test-renderer'
import { descriptors } from '../remote.js'

let declaration
runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { declaration = value } } },
  console, setTimeout, clearTimeout,
})
const client = declaration.factory(name => { if (name === 'react') return React; assert.equal(name, 'zod'); return { z } })
const fixture = {
  agents: [{ id: 'fixture-session' }],
  inventory: { at: Date.now(), agentId: 'fixture-session', scope: 'live-agent', mode: 'native', nativeSkillsComplete: true,
    skills: [{ name: 'workflow', source: 'user-agents', description: '<script>unsafe()</script>', path: '/fixture/SKILL.md', provider: 'capability-gateway', managed: true, modelInvocable: false, userInvocable: true, state: 'managed' }],
    skillRoots: [{ path: '/fixture', state: 'readable', count: 1 }],
    mcp: [{ name: 'bosun', managed: true, state: 'tools_registered', toolCount: 1, presentation: 'gateway', tools: [{ name: 'mcp__bosun__echo', description: 'Echo fixture' }] }],
  },
  activity: { stats: { calls: 0, callSuccessRate: null, searchMisses: 0, searchCount: 0, candidateAdoptionRate: null, routeMismatches: 0, reviewedCorrect: 0, reviewedWrong: 0, correlatedSelections: 0, explicitOrUnlinked: 0, directCalls: 0 },
    events: [], total: 0, storage: { complete: true, maxEvents: 10000, directory: '/fixture/logs' },
  },
}

test('client exports the package module and matching native Remote descriptors', () => {
  assert.equal(declaration.id, 'dsh-capability-gateway')
  assert.deepEqual(JSON.parse(JSON.stringify(client.descriptors)), JSON.parse(JSON.stringify(descriptors)))
  for (let index = 0; index < descriptors.length; index++) {
    assert.deepEqual(z.toJSONSchema(client.descriptors[index].parameters[0].codec.create()), z.toJSONSchema(descriptors[index].parameters[0].codec.create()))
    assert.deepEqual(z.toJSONSchema(client.descriptors[index].result.create()), z.toJSONSchema(descriptors[index].result.create()))
  }
})

test('native settings panel renders expandable inventory lists and escaped descriptions', () => {
  const html = renderToStaticMarkup(React.createElement(client.GatewayPanel, { api: {}, initialSnapshot: fixture }))
  assert.ok(html.includes('能力网关'))
  assert.ok(html.includes('MCP 服务'))
  assert.ok(html.includes('Skills'))
  assert.ok(html.includes('网关管理'))
  assert.ok(html.includes('aria-label="MCP 服务"'))
  assert.ok(html.includes('aria-label="Skills"'))
  assert.ok(html.includes('<ul class="cg-capabilities">'))
  assert.ok(html.includes('<details class="cg-capability">'))
  assert.ok(!html.includes('<table'))
  assert.ok(html.includes('/fixture/SKILL.md'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<script>unsafe'))
  assert.ok(html.includes('查看会话'))
})

test('alias diagnostics appear with inventory and give a concrete repair action', () => {
  const snapshot = { ...fixture, inventory: { ...fixture.inventory, configDiagnostics: {
    complete: false, total: 12, shown: 2, truncated: true, items: [
      { source: 'keywordPacks', index: 1, code: 'file_missing' },
      { source: 'keywordPacks', index: 2, code: 'invalid_entries', count: 2, entries: [1, 3] },
    ],
  } } }
  const html = renderToStaticMarkup(React.createElement(client.GatewayPanel, { api: {}, initialSnapshot: snapshot, initialSection: 'config' }))
  for (const text of ['搜索覆盖不完整', 'keywordPacks 第 1 项', '文件不存在', '条目序号：1、3', '重新加载插件', '当前显示 2 项，共 12 项异常']) assert.ok(html.includes(text), text)
  assert.ok(html.includes('role="status"'))
})

test('UI filters inventory and switches to statistics with explicit no-sample states', async () => {
  let renderer
  const api = { snapshot: async options => { assert.ok(Object.values(options).every(value => value !== undefined)); return fixture }, review: async () => ({}) }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api })) })
  const kind = renderer.root.findAllByType('select').find(x => x.findAllByType('option').some(option => option.props.value === 'skill'))
  await act(async () => kind.props.onChange({ target: { value: 'mcp' } }))
  assert.equal(renderer.root.findAll(x => x.type === 'section' && x.props['aria-label'] === 'Skills').length, 0)
  assert.equal(renderer.root.findAll(x => x.type === 'section' && x.props['aria-label'] === 'MCP 服务').length, 1)
  await act(async () => kind.props.onChange({ target: { value: 'skill' } }))
  assert.equal(renderer.root.findAll(x => x.type === 'section' && x.props['aria-label'] === 'MCP 服务').length, 0)
  await act(async () => kind.props.onChange({ target: { value: '' } }))
  const input = renderer.root.findByProps({ type: 'search' })
  await act(async () => input.props.onChange({ target: { value: 'no-match' } }))
  assert.ok(JSON.stringify(renderer.toJSON()).includes('没有符合条件'))
  const button = renderer.root.findAllByType('button').find(x => x.children.join('') === '使用统计')
  await act(async () => button.props.onClick())
  const output = JSON.stringify(renderer.toJSON())
  assert.ok(output.includes('如需评价能力选择'))
  assert.ok(output.includes('—'))
  assert.ok(!output.includes('0.0%'))
  assert.ok(!output.includes('还没有调用记录'))
  await act(async () => renderer.unmount())
})

test('UI shows failures instead of silently claiming an empty successful inventory', async () => {
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api: {
    snapshot: async () => { throw new Error('fixture transport unavailable') }, review: async () => ({}),
  } })) })
  const error = renderer.root.findByProps({ role: 'alert' })
  assert.ok(error.children.join('').includes('fixture transport unavailable'))
  await act(async () => renderer.unmount())
})

test('record controls submit explicit verdicts without requiring user text', async () => {
  const calls = []
  let renderer
  const event = { id: 'event-id', at: Date.now(), action: 'call', target: 'mcp__bosun__echo', actualTarget: 'mcp__bosun__echo',
    agentId: 'fixture-session', callId: 'call-id', route: 'gateway', kind: 'mcp', outcome: 'success', durationMs: 4,
    candidates: [], searchId: null, candidateRank: null, dispatched: true, routeMatches: true, verdict: 'unreviewed', errorCode: null }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.Records, {
    events: [event], saving: null, onReview: (id, verdict) => calls.push([id, verdict]),
  })) })
  const control = renderer.root.findByType('select')
  await act(async () => control.props.onChange({ target: { value: 'wrong' } }))
  assert.deepEqual(calls, [['event-id', 'wrong']])
  assert.ok(JSON.stringify(renderer.toJSON()).includes('无 10 分钟内可关联搜索'))
  await act(async () => renderer.unmount())
})

function sampleEvent(index) {
  return { id: `event-${index}`, at: Date.now(), action: 'call', target: `mcp__fixture__tool-${index}`, actualTarget: `mcp__fixture__tool-${index}`,
    agentId: 'fixture-session', callId: `call-${index}`, route: 'gateway', kind: 'mcp', outcome: index % 2 ? 'error' : 'success', durationMs: index,
    candidates: [], searchId: null, candidateRank: null, dispatched: true, routeMatches: true, verdict: 'unreviewed', errorCode: null }
}
const namedButton = (renderer, name) => renderer.root.findByProps({ 'aria-label': name })
const selectWithOption = (renderer, value) => renderer.root.findAllByType('select').find(control => control.findAllByType('option').some(option => option.props.value === value))
const switchView = async (renderer, title = '使用统计') => act(async () => renderer.root.findAllByType('button').find(button => button.children.join('') === title).props.onClick())

test('large inventory and server tool sets render bounded pages and reset after filtering', async () => {
  const inventory = { ...fixture.inventory,
    skills: Array.from({ length: 1500 }, (_, index) => ({ ...fixture.inventory.skills[0], name: `skill-${index}`, path: `/fixture/${index}`, managed: index % 2 === 0 })),
    mcp: Array.from({ length: 50 }, (_, index) => ({ ...fixture.inventory.mcp[0], name: `server-${index}`, toolCount: 500,
      tools: Array.from({ length: 500 }, (_, tool) => ({ name: `mcp__server-${index}__tool-${tool}`, description: 'Fixture' })) })),
  }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.Inventory, { inventory, query: '' })) })
  assert.equal(renderer.root.findAllByProps({ className: 'cg-capability' }).length, 20)
  assert.equal(renderer.root.findAllByProps({ className: 'cg-tool-list' }).reduce((sum, list) => sum + list.findAllByType('li').length, 0), 100)
  await act(async () => namedButton(renderer, 'Skills末页').props.onClick())
  assert.ok(JSON.stringify(renderer.toJSON()).includes('skill-1499'))
  await act(async () => renderer.update(React.createElement(client.Inventory, { inventory, query: 'skill-2' })))
  assert.ok(JSON.stringify(renderer.toJSON()).includes('skill-2'))
  assert.ok(namedButton(renderer, 'Skills上一页').props.disabled)
  await act(async () => renderer.update(React.createElement(client.Inventory, { inventory, query: '', kind: 'skill', management: 'native' })))
  const names = renderer.root.findAllByProps({ className: 'cg-capability-name' }).map(row => row.findByType('strong').children.join(''))
  assert.deepEqual(names, Array.from({ length: 10 }, (_, index) => `skill-${index * 2 + 1}`))
  await act(async () => renderer.unmount())
})

test('record paging, page size, direct jump and filters request the complete dataset correctly', async () => {
  let renderer
  const requests = []
  const events = Array.from({ length: 207 }, (_, index) => sampleEvent(206 - index))
  const api = { snapshot: async options => {
    requests.push(options)
    const filtered = events.filter(row => !options.outcome || row.outcome === options.outcome)
    return { ...fixture, activity: { ...fixture.activity, stats: { ...fixture.activity.stats, calls: 207, callSuccessRate: 104 / 207 },
      events: filtered.slice(options.offset, options.offset + options.limit), total: filtered.length, offset: options.offset, limit: options.limit, anchorId: 'event-206' } }
  }, review: async () => ({}) }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api })) })
  await switchView(renderer, '运行日志')
  assert.equal(renderer.root.findAllByProps({ className: 'cg-record' }).length, 10)
  await act(async () => namedButton(renderer, '调用记录下一页').props.onClick())
  assert.equal(requests.at(-1).offset, 10)
  assert.equal(requests.at(-1).anchorId, 'event-206')
  assert.ok(JSON.stringify(renderer.toJSON()).includes('tool-196'))
  await act(async () => namedButton(renderer, '调用记录每页数量').props.onChange({ target: { value: '20' } }))
  assert.equal(requests.at(-1).limit, 20)
  assert.equal(requests.at(-1).offset, 0)
  assert.equal(requests.at(-1).anchorId, undefined)
  await act(async () => namedButton(renderer, '调用记录跳转页码').props.onChange({ target: { value: '8' } }))
  await act(async () => namedButton(renderer, '调用记录跳转页码').props.onKeyDown({ key: 'Enter' }))
  assert.equal(requests.at(-1).offset, 140)
  await act(async () => selectWithOption(renderer, 'error').props.onChange({ target: { value: 'error' } }))
  assert.equal(requests.at(-1).offset, 0)
  assert.equal(requests.at(-1).outcome, 'error')
  assert.equal(requests.at(-1).anchorId, undefined)
  await switchView(renderer)
  assert.ok(JSON.stringify(renderer.toJSON()).includes('50.2%'))
  await switchView(renderer, '运行日志')
  await act(async () => namedButton(renderer, '调用记录末页').props.onClick())
  assert.equal(requests.at(-1).offset, 100)
  assert.equal(renderer.root.findAllByProps({ className: 'cg-record' }).length, 3)
  await act(async () => renderer.unmount())
})

test('failed page requests preserve prior data, show an error, and refresh recovers from the first page', async () => {
  let renderer
  let fail = false
  const requests = []
  const api = { snapshot: async options => {
    requests.push(options)
    if (fail) throw new Error('not_found: history anchor expired; refresh records')
    return { ...fixture, activity: { ...fixture.activity, events: [sampleEvent(5)], total: 50, offset: 0, limit: 10, anchorId: 'event-5' } }
  }, review: async () => ({}) }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api })) })
  await switchView(renderer, '运行日志')
  fail = true
  await act(async () => namedButton(renderer, '调用记录下一页').props.onClick())
  assert.ok(renderer.root.findByProps({ role: 'alert' }).children.join('').includes('上次读取的快照'))
  assert.equal(renderer.root.findAllByProps({ className: 'cg-record' }).length, 1)
  assert.equal(namedButton(renderer, '调用记录下一页').props.disabled, true)
  fail = false
  await act(async () => namedButton(renderer, '刷新快照').props.onClick())
  assert.equal(requests.at(-1).offset, 0)
  assert.equal(requests.at(-1).anchorId, undefined)
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
  await act(async () => renderer.unmount())
})

test('inventory failures beyond the visible page and incomplete statistics stay visible', async () => {
  const inventory = { ...fixture.inventory, nativeSkillsComplete: false,
    skillRoots: [{ path: '/fixture', state: 'error', count: null, errorCode: 'EACCES' }],
    mcp: Array.from({ length: 25 }, (_, index) => ({ ...fixture.inventory.mcp[0], name: `server-${index}`, state: index === 24 ? 'plugin_failed' : 'tools_registered' })),
  }
  const html = renderToStaticMarkup(React.createElement(client.Inventory, { inventory, query: '' }))
  assert.ok(html.includes('1 个启动失败'))
  assert.ok(html.includes('清单可能缺项'))
  assert.ok(html.includes('目录读取失败'))
  assert.ok(!html.includes('server-24</strong>'))
  let renderer
  const api = { snapshot: async () => ({ ...fixture, activity: { ...fixture.activity, storage: { ...fixture.activity.storage, complete: false, invalidLines: 1 } } }) }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api })) })
  await switchView(renderer)
  assert.ok(JSON.stringify(renderer.toJSON()).includes('统计只能代表当前可读取部分'))
  await act(async () => renderer.unmount())
})

test('stats view exports the Host report in both formats without user text', async () => {
  const calls = []
  const api = {
    snapshot: async () => fixture,
    review: async () => ({}),
    report: async options => { calls.push(options); return { format: options.format, filename: `report.${options.format}`, content: '# 能力网关周报', generatedAt: Date.now() } },
  }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api })) })
  await switchView(renderer)
  await act(async () => namedButton(renderer, '导出 Markdown 周报').props.onClick())
  await act(async () => namedButton(renderer, '刷新快照').props.onClick())
  await act(async () => namedButton(renderer, '导出 JSON 周报').props.onClick())
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ format: 'markdown', historyScope: 'all' }, { format: 'json', historyScope: 'all' }])
  assert.ok(JSON.stringify(renderer.toJSON()).includes('只含计数、名称与状态'))
  await act(async () => renderer.unmount())
})

test('selected report pins the displayed automatic session and exposes the scope', async () => {
  const calls = []
  const snapshot = { ...fixture, agents: [{ id: 'fixture-session', title: 'Deployment checks' }] }
  const api = { snapshot: async () => snapshot, report: async options => { calls.push(options); return { filename: 'scope.md', content: 'fixture' } } }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api })) })
  assert.ok(JSON.stringify(renderer.toJSON()).includes('Deployment checks'))
  await switchView(renderer)
  const scope = renderer.root.findAllByType('select').find(x => x.findAllByType('option').some(option => option.props.value === 'selected'))
  await act(async () => scope.props.onChange({ target: { value: 'selected' } }))
  assert.ok(JSON.stringify(renderer.toJSON()).includes('导出范围：所选活动会话'))
  await act(async () => namedButton(renderer, '导出 Markdown 周报').props.onClick())
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ format: 'markdown', historyScope: 'selected', agentId: 'fixture-session' }])
  assert.equal(namedButton(renderer, '导出 Markdown 周报').props.disabled, true, 'a failed download requires refresh before retrying export')
  await act(async () => renderer.unmount())
})

test('incomplete discovery remains visible in activity summary and individual records', () => {
  const snapshot = { ...fixture, activity: { ...fixture.activity, stats: { ...fixture.activity.stats, searchIncomplete: 1 }, events: [
    { ...sampleEvent(1), action: 'search', target: null, matchCount: 0, discoveryIncomplete: true, candidates: [] },
  ] } }
  const html = renderToStaticMarkup(React.createElement(client.GatewayPanel, { api: {}, initialSnapshot: snapshot, initialSection: 'activity' }))
  const statsHtml = renderToStaticMarkup(React.createElement(client.GatewayPanel, { api: {}, initialSnapshot: snapshot, initialSection: 'stats' }))
  assert.ok(statsHtml.includes('1 次搜索的能力发现不完整'))
  assert.ok(!statsHtml.includes('发现不完整 · 0 个候选'))
  assert.ok(html.includes('发现不完整 · 0 个候选'))
})

const scopeFixture = { writable: true, revision: 'revision-1', skillRoots: ['/fixture'], mcpServers: ['bosun'], rootChoices: ['/fixture', '/another'] }
const byText = (renderer, name) => renderer.root.findAllByType('button').find(button => button.children.join('') === name)

test('scope editor preserves configured but undiscovered services and previews explicit changes before saving', async () => {
  const calls = []
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.ScopeEditor, {
    management: { ...scopeFixture, mcpServers: ['undiscovered'] }, inventory: fixture.inventory,
    api: { configure: async options => { calls.push(options); return { message: 'saved' } } }, onSaved: async () => {},
  })) })
  const check = value => renderer.root.findAllByType('label').find(label => label.findAllByType('code').some(code => code.children.join('') === value)).findByType('input')
  assert.equal(check('undiscovered').props.checked, true)
  assert.equal(check('bosun').props.checked, false)
  assert.equal(calls.length, 0)
  await act(async () => check('bosun').props.onChange({ target: { checked: true } }))
  assert.ok(JSON.stringify(renderer.toJSON()).includes('MCP 服务：新增 1，移除 0'))
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ revision: 'revision-1', skillRoots: ['/fixture'], mcpServers: ['undiscovered', 'bosun'] }])
  await act(async () => renderer.unmount())
})

test('scope editor keeps unsaved choices across refresh and refuses stale overwrites until reloaded', async () => {
  const props = { management: scopeFixture, inventory: fixture.inventory, api: {}, onSaved: async () => {} }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.ScopeEditor, props)) })
  const extra = renderer.root.findAllByType('label').find(label => label.findAllByType('code').some(code => code.children.join('') === '/another')).findByType('input')
  await act(async () => extra.props.onChange({ target: { checked: true } }))
  await act(async () => renderer.update(React.createElement(client.ScopeEditor, { ...props, management: { ...scopeFixture, revision: 'revision-2' } })))
  assert.ok(JSON.stringify(renderer.toJSON()).includes('技能目录：新增 1，移除 0'))
  assert.equal(byText(renderer, '保存接管范围').props.disabled, true)
  await act(async () => byText(renderer, '重新载入选择').props.onClick())
  assert.ok(JSON.stringify(renderer.toJSON()).includes('接管范围未变化'))
  await act(async () => renderer.unmount())
})

test('scope save failure is visible and never reports success', async () => {
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.ScopeEditor, {
    management: scopeFixture, inventory: fixture.inventory, api: { configure: async () => { throw new Error('disk unavailable') } }, onSaved: async () => assert.fail('must not refresh as a successful save'),
  })) })
  await act(async () => renderer.root.findAllByType('input').find(input => input.props.type === 'checkbox' && input.props.checked).props.onChange({ target: { checked: false } }))
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.ok(JSON.stringify(renderer.toJSON()).includes('尚未确认保存成功'))
  assert.ok(renderer.root.findByProps({ role: 'alert' }).children.join('').includes('disk unavailable'))
  await act(async () => renderer.unmount())
})

test('search lab shows ranking reasons, ignores stale responses and submits the exact viewed session', async () => {
  let renderer
  let resolveFirst
  const calls = []
  const result = { complete: true, state: 'matched', matchCount: 1, scope: 'live-agent', unavailable: [], results: [{ kind: 'skill', name: 'fixture-skill', description: 'Fixture', reason: 'alias', score: 12 }] }
  const api = { probe: options => { calls.push(options); return calls.length === 1 ? new Promise(resolve => { resolveFirst = resolve }) : Promise.resolve(result) } }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.SearchLab, { api, agentId: 'exact-session' })) })
  const query = () => renderer.root.findByProps({ maxLength: 1000 })
  await act(async () => query().props.onChange({ target: { value: 'old query' } }))
  let first
  await act(async () => { first = renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }) })
  await act(async () => query().props.onChange({ target: { value: 'new query' } }))
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  await act(async () => { resolveFirst({ ...result, state: 'not_found', results: [] }); await first })
  assert.ok(JSON.stringify(renderer.toJSON()).includes('别名匹配'))
  assert.ok(JSON.stringify(renderer.toJSON()).includes('非置信度'))
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { query: 'new query', agentId: 'exact-session' })
  await act(async () => renderer.unmount())
})

test('search lab distinguishes routing, incomplete discovery and request failures', async () => {
  let response = { complete: false, state: 'incomplete', matchCount: 0, scope: 'host-only', unavailable: [{ kind: 'skill', code: 'dependency_missing' }], results: [] }
  let renderer
  const api = { probe: async () => { if (response instanceof Error) throw response; return response } }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.SearchLab, { api })) })
  await act(async () => renderer.root.findByProps({ maxLength: 1000 }).props.onChange({ target: { value: 'fixture query' } }))
  const submit = () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })
  await act(submit)
  assert.ok(JSON.stringify(renderer.toJSON()).includes('不能据此判断未命中'))
  response = { ...response, complete: true, state: 'routing', unavailable: [] }
  await act(submit)
  assert.ok(JSON.stringify(renderer.toJSON()).includes('尚未确认下游能力'))
  response = new Error('transport unavailable')
  await act(submit)
  assert.ok(JSON.stringify(renderer.toJSON()).includes('transport unavailable'))
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('尚未确认下游能力'))
  await act(async () => renderer.unmount())
})

test('diagnostics separates counts and PTC fallback, and never equates direct calls with a defect', () => {
  const html = renderToStaticMarkup(React.createElement(client.Diagnostics, { inventory: { ...fixture.inventory, mcp: [{ ...fixture.inventory.mcp[0], presentation: 'native-sdk', toolCount: 10 }] },
    activity: { ...fixture.activity, stats: { ...fixture.activity.stats, directCalls: 2 }, errors: [{ name: 'invalid_arguments', count: 3 }] },
  }))
  assert.ok(html.includes('10 → 10'))
  assert.ok(html.includes('未支持 PTC 声明精简'))
  assert.ok(html.includes('可能来自显式调用'))
  assert.ok(html.includes('检查工具参数与 schema'))
  assert.ok(html.includes('少于 20 条'))
})

test('diagnostics distinguishes retained declarations from unknown presentation', () => {
  const render = (mode, presentation) => renderToStaticMarkup(React.createElement(client.Diagnostics, {
    inventory: { ...fixture.inventory, mode, mcp: [{ ...fixture.inventory.mcp[0], presentation }] },
    activity: fixture.activity,
  }))
  const native = render('native', 'native')
  assert.ok(native.includes('1 → 1'))
  assert.ok(native.includes('原生模式保留受管 MCP 的工具声明'))
  const unknown = render('unknown', 'unknown')
  assert.ok(unknown.includes('1 → 待确认'))
  assert.ok(unknown.includes('无法确认 MCP 工具声明'))
})

test('confirmed save refreshes the scope baseline without requiring a second reload action', async () => {
  let renderer
  let management = scopeFixture
  const props = { inventory: fixture.inventory, api: { configure: async () => ({ message: '保存完成' }) }, onSaved: async () => {
    management = { ...scopeFixture, revision: 'revision-2', mcpServers: [] }
    renderer.update(React.createElement(client.ScopeEditor, { ...props, management }))
    return { management }
  } }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.ScopeEditor, { ...props, management })) })
  const server = renderer.root.findAllByType('label').find(label => label.findAllByType('code').some(code => code.children.join('') === 'bosun')).findByType('input')
  await act(async () => server.props.onChange({ target: { checked: false } }))
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  const output = JSON.stringify(renderer.toJSON())
  assert.ok(output.includes('保存完成'))
  assert.ok(output.includes('接管范围未变化'))
  assert.ok(!output.includes('请重新载入选择后继续编辑'))
  await act(async () => renderer.unmount())
})

test('configuration keeps the draft across views and statistics opens filtered runtime records', async () => {
  let renderer
  const requests = []
  const snapshot = { ...fixture, management: scopeFixture, activity: {
    ...fixture.activity, stats: { ...fixture.activity.stats, searchMisses: 2 },
  } }
  const api = { snapshot: async options => { requests.push(options); return snapshot } }
  await act(async () => { renderer = TestRenderer.create(React.createElement(client.GatewayPanel, { api })) })
  await switchView(renderer, '配置')
  const server = renderer.root.findAllByType('label').find(row => row.findAllByType('code').some(code => code.children.join('') === 'bosun')).findByType('input')
  await act(async () => server.props.onChange({ target: { checked: false } }))
  await switchView(renderer, '能力清单')
  await switchView(renderer, '配置')
  assert.ok(JSON.stringify(renderer.toJSON()).includes('MCP 服务：新增 0，移除 1'))
  await switchView(renderer)
  await act(async () => byText(renderer, '查看相关记录').props.onClick())
  assert.equal(byText(renderer, '运行日志').props['aria-pressed'], true)
  assert.equal(requests.at(-1).action, 'search')
  assert.equal(requests.at(-1).offset, 0)
  await act(async () => renderer.unmount())
})
