import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as gateway from '../index.js'
import { loadRuntime } from './runtime.js'

const runtime = await loadRuntime()
after(async () => { if (runtime.extracted) await rm(runtime.extracted, { recursive: true, force: true }) })
const { Context, SystemPrompt, ToolRuntime, SkillRegistry, filesystem, createScope } = runtime

async function setup(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-fixture-'))
  const skillRoot = join(root, 'external')
  await mkdir(skillRoot)
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(SkillRegistry, {}).await()
  const owner = ctx.plugin({ inject: ['tools', 'skills', 'systemPrompt'], apply() {} })
  await owner.await()
  const agent = { session: { id: 'fixture-agent' } }
  const scope = createScope(owner.ctx, agent)
  agent.ctx = scope.ctx
  await ctx.plugin({ apply(registryCtx) { registryCtx.provide('agents', { list: () => [agent], get: id => id === agent.session.id ? agent : undefined }) } }).await()
  const fiber = ctx.plugin(gateway, {
    skillRoots: [skillRoot], mcpServers: ['bosun'], logDir: join(root, 'activity'), localAliases: false, ...config,
  })
  await fiber.await()
  let calls = 0
  function registerTool(name = 'mcp__bosun__echo', render) {
    return ctx.tools.register({
      name, description: 'Echo diagnostic fixture',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
      output: { schema: { type: 'string' }, render: render ?? ((_args, value) => [{ type: 'text', text: value }]) },
      execute(args, exec) { calls++; assert.equal(exec.agent, agent); return args.value ?? 'ok' },
    })
  }
  const invoke = (args, opts = {}) => ctx.tools.execute({
    callId: 'gateway-fixture-call', name: 'capability', arguments: args,
    signal: new AbortController().signal, agent, ...opts,
  })
  return { ctx, fiber, agent, root, skillRoot, registerTool, invoke, calls: () => calls }
}

function text(result) { return result.content.filter(x => x.type === 'text').map(x => x.text).join('\n') }
async function skill(root, name, description = 'External diagnostic workflow', extra = '', body = 'Follow diagnostic instructions.') {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`)
  return dir
}

test('activation injects systemPrompt and registers gateway + prompt hint', async t => {
  const { ctx } = await setup(t)
  assert.ok(ctx.tools.get('capability'))
  const prompt = await ctx.systemPrompt.assemble()
  assert.ok(prompt.sections.some(x => x.name === 'capability-gateway'))
})

test('native prompt hides only selected MCP schemas and proxy retains caller', async t => {
  const f = await setup(t)
  f.registerTool()
  f.registerTool('mcp__other__echo')
  const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  assert.ok(!prompt.tools.some(x => x.name === 'mcp__bosun__echo'))
  assert.ok(prompt.tools.some(x => x.name === 'mcp__other__echo'))
  assert.ok(f.ctx.tools.get('mcp__bosun__echo', f.agent))
  assert.match(text(await f.invoke({ action: 'describe', name: 'mcp__bosun__echo' })), /Parameters \(JSON Schema\)/)
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo', arguments: { value: 'hello' } })
  assert.ok(!result.isError, text(result))
  assert.equal(text(result), 'hello')
  assert.equal(f.calls(), 1)
})

test('scoped restrictions prevent discovery and calling; no global bypass', async t => {
  const f = await setup(t)
  f.registerTool()
  f.agent.ctx.tools.restrict({ deny: ['mcp__bosun__echo'] })
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  assert.ok(result.isError)
  assert.match(text(result), /unavailable:/)
  assert.equal(f.calls(), 0)
  assert.ok((await f.invoke({ action: 'describe', name: 'mcp__bosun__echo' })).isError)
})

test('scoped monotonic guard still blocks gateway proxy', async t => {
  const f = await setup(t)
  f.registerTool()
  f.agent.ctx.tools.guard(exec => exec.name === 'mcp__bosun__echo' ? 'Fixture permission denied' : undefined)
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  assert.ok(result.isError)
  assert.match(text(result), /Fixture permission denied/)
  assert.equal(f.calls(), 0)
})

test('nested execution preserves native policy events and correlation', async t => {
  const f = await setup(t)
  f.registerTool()
  const seen = []
  f.ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'mcp__bosun__echo') seen.push(exec)
    return next()
  })
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  assert.ok(!result.isError, text(result))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agent, f.agent)
  assert.ok(seen[0].parent)
  assert.equal(seen[0].rootCallId, 'gateway-fixture-call')
})

test('proxy preserves images and structured native result', async t => {
  const f = await setup(t)
  const image = { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }
  f.registerTool(undefined, () => [{ type: 'text', text: 'image result' }, image])
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  assert.ok(!result.isError, text(result))
  assert.deepEqual(result.content[1], image)
  assert.equal(result.value.value, 'ok')
})

test('skills hide from native model catalog, still load and support user invocation', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'diagnostic')
  const catalog = await f.ctx.skills.snapshot({ scope: f.agent })
  const item = catalog.skills.find(x => x.name === 'diagnostic')
  assert.equal(item.invocation.modelInvocable, false)
  assert.equal(item.invocation.userInvocable, true)
  assert.match(text(await f.invoke({ action: 'search', query: 'diagnostic' })), /diagnostic \[技能\]/)
  assert.match(text(await f.invoke({ action: 'load', name: 'diagnostic' })), /Follow diagnostic instructions/)
  assert.match((await f.ctx.skills.get('diagnostic', { scope: f.agent })).content, /Follow diagnostic/)
})

test('global shadow respects higher priority personal/project and scoped winners', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'diagnostic')
  f.agent.ctx.skills.register({ name: 'diagnostic', description: 'Personal override', content: 'Keep personal', source: 'project-dsh' })
  const catalog = await f.ctx.skills.snapshot({ scope: f.agent })
  assert.equal(catalog.skills.find(x => x.name === 'diagnostic').invocation.modelInvocable, true)
  const result = await f.invoke({ action: 'load', name: 'diagnostic' })
  assert.ok(result.isError)
  assert.match((await f.ctx.skills.get('diagnostic', { scope: f.agent })).content, /Keep personal/)
})

test('native filesystem rank keeps project winner above external overlay', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'diagnostic')
  await skill(join(f.root, '.dsh/skills'), 'diagnostic', 'Project workflow', '', 'Project instructions')
  await f.ctx.plugin(filesystem, { includeDefaultRoots: true, customSkillDirs: [f.skillRoot], dshHome: join(f.root, 'dsh-home'), agentsHome: join(f.root, 'agents-home'), watch: false }).await()
  const snapshot = await f.ctx.skills.snapshot({ scope: f.agent, cwd: f.root })
  assert.equal(snapshot.skills.find(x => x.name === 'diagnostic').source, 'project-dsh')
})

test('user-only skills remain user-only and symlinked opted-in skills are discoverable', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'user-only', 'Manual workflow', 'disable-model-invocation: true\n')
  const dir = await skill(join(f.root, 'source'), 'linked-skill')
  await symlink(dir, join(f.skillRoot, 'linked-skill'))
  const result = await f.invoke({ action: 'search', query: '' })
  assert.ok(!result.isError, text(result))
  assert.match(text(result), /linked-skill/)
  assert.ok(!text(result).includes('user-only'))
  assert.ok((await f.invoke({ action: 'load', name: 'user-only' })).isError)
})

test('missing root produces dependency_missing rather than empty success', async t => {
  const f = await setup(t, { skillRoots: ['/nonexistent/dsh-gateway-fixture-root'] })
  const result = await f.invoke({ action: 'search', query: 'diagnostic' })
  assert.ok(result.isError)
  assert.match(text(result), /dependency_missing:/)
  f.registerTool()
  assert.ok(!(await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })).isError)
})

test('MCP disconnect/unregistration does not trigger recursive tools/change and returns unavailable', async t => {
  const f = await setup(t)
  const dispose = f.registerTool()
  assert.ok(!(await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })).isError)
  dispose()
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  assert.ok(result.isError)
  assert.match(text(result), /unavailable:/)
})

test('plugin unload restores native exposure and removes shadow/provider/hint', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'diagnostic')
  await f.ctx.plugin(filesystem, { includeDefaultRoots: false, customSkillDirs: [f.skillRoot], watch: false }).await()
  f.registerTool()
  assert.equal((await f.ctx.skills.list({ scope: f.agent })).find(x => x.name === 'diagnostic').invocation.modelInvocable, false)
  await f.fiber.dispose()
  assert.equal(f.ctx.tools.get('capability'), undefined)
  const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  assert.ok(prompt.tools.some(x => x.name === 'mcp__bosun__echo'))
  assert.ok(!prompt.sections.some(x => x.name === 'capability-gateway'))
  assert.equal((await f.ctx.skills.list({ scope: f.agent })).find(x => x.name === 'diagnostic').invocation.modelInvocable, true)
})

test('disabled plugin leaves native schemas unchanged', async t => {
  const f = await setup(t, { enabled: false, skillRoots: ['~/.dsh/skills'] })
  f.registerTool()
  assert.equal(f.ctx.tools.get('capability'), undefined)
  assert.ok((await f.ctx.systemPrompt.assemble({ scope: f.agent })).tools.some(x => x.name === 'mcp__bosun__echo'))
})

test('invalid arguments and upstream failures remain errors', async t => {
  const f = await setup(t)
  f.registerTool()
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo', arguments: [] })
  assert.ok(result.isError)
  assert.equal(f.calls(), 0)
  assert.match(text(result), /invalid_arguments:/)
  f.ctx.tools.register({
    name: 'mcp__bosun__failure', description: 'Failure fixture', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { throw new Error('upstream failure fixture') },
  })
  const failed = await f.invoke({ action: 'call', name: 'mcp__bosun__failure' })
  assert.ok(failed.isError)
  assert.match(text(failed), /execution_failed:.*upstream failure fixture/)
  assert.ok((await f.invoke({ action: 'invalid' })).isError)
})


test('PTC SDK hides managed declarations while keeping scoped execution and native tools', async t => {
  const f = await setup(t)
  f.registerTool()
  f.registerTool('mcp__other__echo')
  await f.ctx.plugin({ apply(ctx) { ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' }) } }).await()
  f.agent.ctx.tools.presentAs('ptc')
  const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  const sdk = prompt.sections.find(x => x.name === 'tools:sdk').text
  assert.ok(!sdk.includes('mcp__bosun__echo'))
  assert.ok(sdk.includes('mcp__other__echo'))
  assert.ok(sdk.includes('capability'))
  assert.ok(sdk.length < f.ctx.tools.sdkSection().text({ scope: f.agent }).length, 'managed declarations must reduce the SDK prompt')
  assert.deepEqual(prompt.tools.map(x => x.name), ['run_code'])
  assert.ok(f.ctx.tools.sdkSchemas(f.agent).some(x => x.name === 'mcp__bosun__echo'), 'execution registry stays intact')
  const status = await f.invoke({ action: 'status' }, { parent: {} })
  assert.ok(!status.isError, text(status))
  assert.match(text(status), /1 tools omitted from PTC SDK declarations/)
  const result = await f.invoke({ action: 'call', name: 'mcp__bosun__echo' }, { parent: {} })
  assert.ok(!result.isError, text(result))
  assert.equal(f.calls(), 1)
  f.agent.ctx.tools.restrict({ deny: ['mcp__bosun__echo'] })
  assert.ok((await f.invoke({ action: 'call', name: 'mcp__bosun__echo' }, { parent: {} })).isError)
  assert.equal(f.calls(), 1)
})

test('native run_code dispatches capability through the scheduler and preserves guards', async t => {
  const f = await setup(t)
  f.registerTool()
  f.agent.session.append = () => {}
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  await f.ctx.plugin({ apply(ctx) {
    ctx.provide('workingDirectory', { ensure: () => f.root })
    ctx.provide('ptcRuntime', {
      language: 'typescript', programFormat: 'function-body', release() {}, resolve: input => input,
      async run(input) {
        try { return { logs: [], value: await new AsyncFunction('tools', input.program)(input.bindings[0].functions) } }
        catch (error) { return { logs: [], error: { kind: 'fixture', message: error.message } } }
      },
    })
  } }).await()
  f.agent.ctx.tools.presentAs('ptc')
  const run = () => f.ctx.tools.execute({ callId: 'ptc-root', name: 'run_code',
    arguments: { code: 'return await tools.capability({ action: "call", name: "mcp__bosun__echo", arguments: { value: "ptc-ok" } })', description: 'Isolated gateway call' },
    signal: new AbortController().signal, agent: f.agent })
  const success = await run()
  assert.ok(!success.isError, text(success))
  assert.match(text(success), /ptc-ok/)
  assert.equal(f.calls(), 1)
  f.agent.ctx.tools.guard(exec => exec.name === 'mcp__bosun__echo' ? 'PTC fixture denied' : undefined)
  const denied = await run()
  assert.ok(denied.isError)
  assert.match(text(denied), /PTC fixture denied/)
  assert.equal(f.calls(), 1)
})

test('PTC rendering stays scoped, updates with tools, and unload restores declarations', async t => {
  const f = await setup(t, { wrapSkills: false })
  const remove = f.registerTool()
  await f.ctx.plugin({ apply(ctx) { ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' }) } }).await()
  f.agent.ctx.tools.presentAs('ptc')
  const sdk = async () => (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'tools:sdk').text
  const first = await sdk()
  const second = await sdk()
  assert.equal(first, second)
  const hint = async () => (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'capability-gateway').text
  assert.equal((await hint()).split('mcp__bosun__echo').length - 1, 1, 'repeated assembly must not accumulate names')
  const snapshot = await f.ctx.capabilityGateway.snapshot({ agentId: 'fixture-agent' })
  assert.equal(snapshot.inventory.mcp.find(x => x.name === 'bosun').presentation, 'gateway-sdk')
  const native = await f.ctx.systemPrompt.assemble()
  assert.ok(!native.tools.some(x => x.name === 'mcp__bosun__echo'))
  assert.ok(!native.sections.some(x => x.name === 'tools:sdk'))
  remove()
  assert.ok(!(await hint()).includes('mcp__bosun__echo'), 'removed tools must not linger in the name index')
  assert.ok(!f.ctx.tools.sdkSchemas(f.agent).some(x => x.name === 'mcp__bosun__echo'))
  f.registerTool('mcp__bosun__new')
  assert.ok(!(await sdk()).includes('mcp__bosun__new'))
  await f.fiber.dispose()
  assert.ok((await sdk()).includes('mcp__bosun__new'))
})

test('Python PTC SDK uses the host renderer and omits only managed tools', async t => {
  const f = await setup(t)
  f.registerTool()
  f.registerTool('mcp__other__echo')
  await f.ctx.plugin({ apply(ctx) { ctx.provide('ptcRuntime', { language: 'python', programFormat: 'program' }) } }).await()
  f.agent.ctx.tools.presentAs('ptc')
  const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  const sdk = prompt.sections.find(x => x.name === 'tools:sdk').text
  assert.ok(!sdk.includes('mcp__bosun__echo'))
  assert.ok(sdk.includes('mcp__other__echo'))
  assert.ok(sdk.includes('capability'))
})

test('PTC renderer failures stay explicit instead of yielding an empty successful SDK', async t => {
  const f = await setup(t)
  f.registerTool()
  await f.ctx.plugin({ apply(ctx) { ctx.provide('ptcRuntime', { language: 'unsupported-fixture', programFormat: 'program' }) } }).await()
  f.agent.ctx.tools.presentAs('ptc')
  await assert.rejects(f.ctx.systemPrompt.assemble({ scope: f.agent }), /no SDK renderer registered/)
})

test('disabled and unwrapped PTC gateways leave the host SDK unchanged', async t => {
  for (const config of [{ enabled: false }, { wrapMcp: false }]) {
    const f = await setup(t, config)
    f.registerTool()
    await f.ctx.plugin({ apply(ctx) { ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' }) } }).await()
    f.agent.ctx.tools.presentAs('ptc')
    const sdk = (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'tools:sdk').text
    assert.ok(sdk.includes('mcp__bosun__echo'))
  }
})

test('unsupported host PTC presentation API retains the SDK with an explicit status', async t => {
  const f = await setup(t)
  f.registerTool()
  await f.fiber.dispose()
  // An older host can still provide PTC while lacking the SDK section factory.
  const section = f.ctx.tools.sdkSection()
  f.ctx.tools.sdkSection = undefined
  await f.ctx.plugin(gateway, { wrapSkills: false, mcpServers: ['bosun'], logDir: join(f.root, 'unsupported') }).await()
  await f.ctx.plugin({ apply(ctx) { ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' }) } }).await()
  f.ctx.systemPrompt.section(section)
  f.ctx.tools.defaultMode = 'ptc'
  const sdk = (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'tools:sdk').text
  assert.ok(sdk.includes('mcp__bosun__echo'))
  assert.match(text(await f.invoke({ action: 'status' }, { parent: {} })), /host presentation API unsupported/)
})

test('YAML invocation comments, quoted values and invalid policies follow native semantics', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'commented-manual', 'Manual workflow', 'disable-model-invocation: true # user only\n')
  await skill(f.skillRoot, 'quoted-manual', 'Manual workflow', 'disable-model-invocation: "yes"\n')
  await skill(f.skillRoot, 'normal', 'Regular workflow', 'user-invocable: false # keep model access\n')
  const result = await f.invoke({ action: 'search', query: '' })
  assert.ok(!result.isError, text(result))
  assert.ok(!text(result).includes('commented-manual'))
  assert.ok(!text(result).includes('quoted-manual'))
  assert.ok(text(result).includes('normal'))
  assert.equal((await f.ctx.skills.get('normal', { scope: f.agent })).invocation.userInvocable, false)
  await skill(f.skillRoot, 'invalid-policy', 'Invalid workflow', 'disable-model-invocation: perhaps\n')
  // Wait only for filesystem invalidation, bounded by the scan TTL.
  for (let attempt = 0; attempt < 220; attempt++) {
    const next = await f.invoke({ action: 'load', name: 'invalid-policy' })
    if (/invalid boolean/.test(text(next))) { assert.ok(next.isError); return }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('invalid invocation policy did not become a distinguishable discovery error')
})

test('editing nested skill file invalidates both scan and native provider cache', async t => {
  const f = await setup(t)
  const dir = await skill(f.skillRoot, 'diagnostic', 'Before description')
  await f.invoke({ action: 'search', query: '' })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: diagnostic\ndescription: After description\n---\nUpdated body\n')
  for (let attempt = 0; attempt < 220; attempt++) {
    const catalog = await f.ctx.skills.list({ scope: f.agent })
    if (catalog.find(x => x.name === 'diagnostic')?.description === 'After description') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('nested edit did not invalidate cached native skill summary')
})

test('DSH per-agent filesystem skills still enter the gateway; protected global winners remain native', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'diagnostic')
  await f.agent.ctx.plugin(filesystem, { includeDefaultRoots: false, customSkillDirs: [f.skillRoot], watch: false }).await()
  assert.equal((await f.ctx.skills.list({ scope: f.agent })).find(x => x.name === 'diagnostic').provider, 'capability-gateway')
  f.ctx.skills.register({ name: 'diagnostic', description: 'Global personal skill', content: 'Keep global personal', source: 'user-dsh' })
  const snapshot = await f.ctx.skills.list({ scope: f.agent })
  assert.notEqual(snapshot.find(x => x.name === 'diagnostic').provider, 'capability-gateway')
  assert.ok((await f.invoke({ action: 'load', name: 'diagnostic' })).isError)
})

test('inventory includes wrapped and native services, per-scope skills and unknown zero-tool servers', async t => {
  const f = await setup(t, { mcpServers: ['bosun', 'missing'] })
  await skill(f.skillRoot, 'diagnostic')
  f.registerTool()
  f.registerTool('mcp__other__echo')
  const snapshot = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(snapshot.inventory.agentId, 'fixture-agent')
  assert.equal(snapshot.inventory.skills.find(x => x.name === 'diagnostic').managed, true)
  assert.equal(snapshot.inventory.mcp.find(x => x.name === 'bosun').presentation, 'gateway')
  assert.equal(snapshot.inventory.mcp.find(x => x.name === 'other').managed, false)
  assert.equal(snapshot.inventory.mcp.find(x => x.name === 'missing').state, 'no_tools_observed')
  assert.equal(snapshot.activity.stats.callSuccessRate, null)
  await assert.rejects(f.ctx.get('capabilityGateway').snapshot({ agentId: 'deleted' }), /not_found/)
})

test('inventory keeps independent MCP results when skill discovery fails', async t => {
  const f = await setup(t, { skillRoots: ['/nonexistent/dsh-gateway-fixture-root'] })
  f.registerTool()
  const snapshot = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(snapshot.inventory.skillRoots[0].state, 'error')
  assert.equal(snapshot.inventory.nativeSkillsComplete, false)
  assert.equal(snapshot.inventory.mcp[0].toolCount, 1)
})

test('search → call correlation, manual feedback and direct calls are separately counted', async t => {
  const f = await setup(t)
  f.registerTool()
  const privateQuery = 'Echo diagnostic fixture'
  const searchResult = await f.invoke({ action: 'search', query: privateQuery })
  assert.ok(!searchResult.isError, text(searchResult))
  await f.invoke({ action: 'call', name: 'mcp__bosun__echo', arguments: { value: 'secret body' } })
  await f.ctx.tools.execute({ callId: 'direct-call', name: 'mcp__bosun__echo', arguments: {}, agent: f.agent, signal: new AbortController().signal })
  const service = f.ctx.get('capabilityGateway')
  let snapshot = await service.snapshot()
  assert.equal(snapshot.activity.stats.calls, 1)
  assert.equal(snapshot.activity.stats.directCalls, 1)
  assert.equal(snapshot.activity.stats.correlatedSelections, 1)
  assert.equal(snapshot.activity.stats.insideCandidates, 1)
  const call = snapshot.activity.events.find(x => x.route === 'gateway' && x.action === 'call')
  assert.equal(call.routeMatches, true)
  assert.equal(call.dispatched, true)
  await service.review({ eventId: call.id, verdict: 'wrong' })
  snapshot = await service.snapshot()
  assert.equal(snapshot.activity.stats.reviewedWrong, 1)
  const { readdir, readFile } = await import('node:fs/promises')
  const file = (await readdir(join(f.root, 'activity'))).find(x => x.endsWith('.jsonl'))
  const raw = await readFile(join(f.root, 'activity', file), 'utf8')
  assert.ok(!raw.includes(privateQuery))
  assert.ok(!raw.includes('secret body'))
  assert.ok(!raw.includes('arguments'))
})

test('native denial is finalized as a failed call without an actual dispatch', async t => {
  const f = await setup(t)
  f.registerTool()
  f.agent.ctx.tools.guard(exec => exec.name === 'mcp__bosun__echo' ? 'private denial detail' : undefined)
  await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(activity.stats.calls, 1)
  assert.equal(activity.stats.callErrors, 1)
  assert.equal(activity.stats.callSuccesses, 0)
  assert.equal(activity.events[0].dispatched, false)
  assert.ok(!JSON.stringify(activity).includes('private denial detail'))
})

test('native Typert gateway can invoke the contributed snapshot and denies a non-owner peer', async t => {
  const f = await setup(t)
  await f.ctx.plugin(runtime.TypertRegistry).await()
  await f.ctx.plugin({ apply(ctx) { ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'policy' }) }) } }).await()
  await f.ctx.plugin(runtime.TypertGateway, {}).await()
  const peer = new runtime.Peer(f.ctx, { principal: { kind: 'owner' }, interactions: 'none' })
  const request = { namespace: 'capabilityGateway', method: 'snapshot', args: { options: {} }, peer }
  const result = await f.ctx.get('typertGateway').invoke(request)
  assert.equal(result.inventory.agentId, 'fixture-agent')
  const other = new runtime.Peer(f.ctx, { principal: { kind: 'user', id: 'outsider' }, interactions: 'none' })
  await assert.rejects(f.ctx.get('typertGateway').invoke({ ...request, peer: other }), /denied|policy/)
})

test('configured inactive MCP entries are visible without exposing credentials or transport config', async t => {
  const f = await setup(t)
  const entries = [{ id: 'mcp-disabled', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'disabled-service', url: 'https://private.invalid?token=secret', headers: { Authorization: 'Bearer secret' } } }, disabled: true },
    { id: 'mcp-failed', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'failed-service', env: { SECRET: 'secret' } } }, disabled: false, fiber: { state: 3 } }]
  await f.ctx.plugin({ apply(ctx) { ctx.provide('loader', { entries: () => entries }) } }).await()
  const { inventory } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(inventory.mcp.find(x => x.name === 'disabled-service').state, 'disabled')
  assert.equal(inventory.mcp.find(x => x.name === 'failed-service').state, 'plugin_failed')
  assert.ok(!/secret|Authorization|headers|private.invalid/.test(JSON.stringify(inventory)))
})

test('a native dispatch target change is observable as a routing mismatch', async t => {
  const f = await setup(t)
  f.registerTool()
  f.registerTool('mcp__bosun__second')
  f.ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'mcp__bosun__echo' && exec.parent) exec.name = 'mcp__bosun__second'
    return next()
  })
  await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(activity.stats.calls, 1)
  assert.equal(activity.stats.routeMismatches, 1)
  assert.equal(activity.events[0].target, 'mcp__bosun__echo')
  assert.equal(activity.events[0].actualTarget, 'mcp__bosun__second')
})

test('search correlation does not leak between agents and stats can be scoped to one agent', async t => {
  const f = await setup(t)
  f.ctx.tools.register({ name: 'mcp__bosun__shared', description: 'shared echo', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => 'ok' })
  await f.invoke({ action: 'search', query: 'shared' })
  const other = { session: { id: 'another-agent' } }
  other.ctx = createScope(f.ctx, other).ctx
  await f.invoke({ action: 'call', name: 'mcp__bosun__shared' }, { agent: other })
  const stats = await f.invoke({ action: 'stats' }, { agent: other })
  const parsed = JSON.parse(text(stats))
  assert.equal(parsed.stats.calls, 1)
  assert.equal(parsed.stats.correlatedSelections, 0)
  assert.equal(parsed.stats.explicitOrUnlinked, 1)
})

test('gateway preserves successful tool completion when journaling cannot write', async t => {
  const f = await setup(t)
  await writeFile(join(f.root, 'activity'), 'not a directory')
  f.registerTool()
  const call = await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  assert.ok(!call.isError, text(call))
  assert.equal(f.calls(), 1)
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(activity.stats.callSuccesses, 1)
  assert.equal(activity.storage.complete, false)
  assert.ok(activity.storage.writeError)
})

test('invalid diagnostic filters fail explicitly instead of widening the requested scope', async t => {
  const f = await setup(t)
  const service = f.ctx.get('capabilityGateway')
  for (const input of [null, [], 'wrong', { agentId: 4 }, { historyScope: 'other' }, { outcome: 'failed' }, { limit: -1 }, { offset: -1 }, { offset: 1.5 }, { offset: 10001 }, { anchorId: '' }, { anchorId: 1 }]) {
    await assert.rejects(service.snapshot(input), /invalid_arguments:/)
  }
})

test('Chinese ve/ECS search uses word boundaries, bounded summaries and kind filters', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'passport-develop', 'Develop and improve a FoloToy application with device handoff.')
  await skill(f.skillRoot, 'better-accessibility', 'Improve accessibility and focus for web interfaces.')
  await skill(f.skillRoot, 'better-colors', 'Improve colors and contrast in a web application.')
  await skill(f.skillRoot, 'volcengine-cli', 'Use the ve command to query ECS instances and manage Volcengine cloud resources. ' + 'Detailed instructions. '.repeat(30))
  await skill(f.skillRoot, 'volcengine-feedback', 'Submit feedback for Volcengine cloud skills and CLI workflows.')
  await skill(f.skillRoot, 'chinese-cloud', '查询云资源实例列表并核对运行状态。')
  f.registerTool('mcp__bosun__ecs')
  for (const query of ['用 ve 命令查 ECS 实例列表', 'volcengine ecs', 've']) {
    const result = await f.invoke({ action: 'search', query, kind: 'skill' })
    assert.ok(!result.isError, text(result))
    const lines = text(result).split('\n').filter(x => x.startsWith('- '))
    assert.match(lines[0], /volcengine-cli \[技能\]/)
    assert.ok(!text(result).includes('passport-develop'))
    assert.ok(!text(result).includes('better-accessibility'))
    assert.ok(!text(result).includes('better-colors'))
    assert.ok(!text(result).includes('mcp__bosun__'))
    assert.ok(lines.every(line => Array.from(line.split(' — ')[1]).length <= 120))
    assert.ok(text(result).length < 1100)
  }
  assert.match(text(await f.invoke({ action: 'search', query: '查询实例列表', kind: 'skill' })), /chinese-cloud \[技能\]/)
  const mcp = await f.invoke({ action: 'search', query: 'ecs', kind: 'mcp' })
  assert.match(text(mcp), /mcp__bosun__ecs \[MCP服务：bosun\]/)
  assert.ok(!text(mcp).includes('volcengine-cli'))
  const missing = await f.invoke({ action: 'search', query: '把这份 Excel 拆成多个 sheet 并核对公式' })
  assert.ok(missing.isError)
  assert.match(text(missing), /not_found:.*只.*已接管.*不代表 DSH 没有此能力/)
  assert.match(text(missing), /原生.*按原方式/)
  assert.match(text(await f.invoke({ action: 'search', query: 'ecs', kind: 'other' })), /invalid_arguments:/)
})

test('call rejects invalid parameters locally with the describe schema and records no dispatch', async t => {
  const f = await setup(t)
  let calls = 0
  const parameters = { type: 'object', properties: {
    endpoint: { type: 'string' }, payload: { type: 'object', properties: { mode: { type: 'string', enum: ['read'] } }, required: ['mode'], additionalProperties: false },
  }, required: ['endpoint'], additionalProperties: false }
  const register = schema => f.ctx.tools.register({ name: 'mcp__bosun__request', description: 'Fixture request', parameters: schema,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute() { calls++; return 'ok' } })
  const dispose = register(parameters)
  const describe = text(await f.invoke({ action: 'describe', name: 'mcp__bosun__request' }))
  const describedSchema = JSON.parse(describe.split('Parameters (JSON Schema):\n')[1].split('\n\nCall it')[0])
  for (const args of [undefined, { endpoint: 7 }, { endpoint: 'fixture', unexpected: true }, { endpoint: 'fixture', payload: {} }, { endpoint: 'fixture', payload: { mode: 'write' } }]) {
    const result = await f.invoke({ action: 'call', name: 'mcp__bosun__request', ...(args === undefined ? {} : { arguments: args }) })
    assert.ok(result.isError, text(result))
    assert.match(text(result), /invalid_arguments:/)
    assert.deepEqual(JSON.parse(text(result).split('Parameters (JSON Schema):\n')[1]), describedSchema)
  }
  assert.equal(calls, 0)
  let activity = (await f.ctx.get('capabilityGateway').snapshot()).activity
  assert.equal(activity.stats.callErrors, 5)
  assert.equal(activity.stats.callRejected, 5)
  assert.equal(activity.stats.callSuccessRate, null)
  assert.ok(activity.events.filter(x => x.action === 'call').every(x => !x.dispatched && x.errorCode === 'invalid_arguments'))
  assert.ok(!(await f.invoke({ action: 'call', name: 'mcp__bosun__request', arguments: { endpoint: 'fixture', payload: { mode: 'read' } } })).isError)
  assert.equal(calls, 1)
  activity = (await f.ctx.get('capabilityGateway').snapshot()).activity
  assert.equal(activity.stats.callDispatched, 1)
  assert.equal(activity.stats.callRejected, 5)
  assert.equal(activity.stats.callSuccessRate, 1)
  dispose()
  register({ type: 'object', properties: { endpoint: { type: 'string' }, token: { type: 'string' } }, required: ['endpoint', 'token'] })
  assert.match(text(await f.invoke({ action: 'call', name: 'mcp__bosun__request', arguments: { endpoint: 'fixture' } })), /invalid_arguments:.*token/)
  assert.equal(calls, 1)
})

test('model inventory is compact, kind scoped and keeps discovery failures explicit', async t => {
  const f = await setup(t, { mcpServers: ['bosun', 'missing-a', 'missing-b', 'missing-c'] })
  await skill(f.skillRoot, 'diagnostic', 'Large description '.repeat(50))
  f.registerTool()
  f.ctx.skills.register({ name: 'office-xlsx', description: 'Native spreadsheet functionality', content: 'Native instructions', source: 'user-dsh' })
  const allText = text(await f.invoke({ action: 'inventory', limit: 2 }))
  const all = JSON.parse(allText)
  assert.equal(all.counts.skills.total, 2)
  assert.equal(all.counts.skills.managed, 1)
  assert.equal(all.counts.mcp.servers, 4)
  assert.equal(all.anomalies.items.length, 2)
  assert.equal(all.anomalies.truncated, true)
  assert.ok(!allText.includes('Large description'))
  assert.ok(!allText.includes('Native instructions'))
  assert.ok(allText.length < 1600)
  const skills = JSON.parse(text(await f.invoke({ action: 'inventory', kind: 'skill' })))
  assert.ok(skills.counts.skills)
  assert.equal(skills.counts.mcp, undefined)
  assert.ok(skills.skillRoots.length)
  const mcp = JSON.parse(text(await f.invoke({ action: 'inventory', kind: 'mcp' })))
  assert.ok(mcp.counts.mcp)
  assert.equal(mcp.counts.skills, undefined)
  assert.equal(mcp.skillRoots, undefined)
  const ui = await f.ctx.get('capabilityGateway').snapshot()
  assert.ok(ui.inventory.skills.find(x => x.name === 'diagnostic').description)
  assert.ok(ui.inventory.mcp.find(x => x.name === 'bosun').tools.length)
  await rm(f.skillRoot, { recursive: true })
  const failed = JSON.parse(text(await f.invoke({ action: 'inventory', kind: 'skill' })))
  assert.equal(failed.complete, false)
  assert.equal(failed.skillRoots[0].state, 'error')
  assert.equal(failed.skillRoots[0].count, null)
  assert.ok(failed.anomalies.total > 0)
  assert.ok(!(await f.invoke({ action: 'search', query: 'echo', kind: 'mcp' })).isError)
})

test('loader views deduplicate registrations by entryId while preserving conflicts', async t => {
  const f = await setup(t)
  const entry = { id: 'shared-entry', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'bosun', env: { SECRET: 'never-export' } } }, disabled: false, fiber: { state: 2 } }
  let entries = [entry, { ...entry }]
  await f.ctx.plugin({ apply(ctx) { ctx.provide('loader', { entries: () => entries }) } }).await()
  let catalog = (await f.ctx.get('capabilityGateway').snapshot()).inventory
  assert.equal(catalog.mcp.find(x => x.name === 'bosun').registrations.length, 1)
  entries = [entry, { ...entry, fiber: { state: 3 } }]
  catalog = (await f.ctx.get('capabilityGateway').snapshot()).inventory
  const server = catalog.mcp.find(x => x.name === 'bosun')
  assert.equal(server.registrations.length, 1)
  assert.equal(server.registrations[0].conflict, true)
  assert.equal(server.state, 'plugin_failed')
  assert.ok(!JSON.stringify(catalog).includes('never-export'))
})

test('unmatched downstream names return scoped routing entries without claiming a direct match or calling upstream', async t => {
  const f = await setup(t)
  f.registerTool('mcp__bosun__search_tools')
  f.registerTool('mcp__bosun__list_endpoints')
  f.registerTool('mcp__bosun__call_endpoint')
  f.registerTool('mcp__bosun__delete_endpoint')
  f.registerTool('mcp__native__search_tools')
  for (const query of ['grafana', 'metabase', 'purser']) {
    const result = await f.invoke({ action: 'search', query, kind: 'mcp', limit: 2 })
    assert.ok(!result.isError, text(result))
    assert.match(text(result), /无直接匹配.*不代表已找到目标能力/)
    const lines = text(result).split('\n').filter(x => x.startsWith('- '))
    assert.equal(lines.length, 2)
    assert.match(lines[0], /mcp__bosun__search_tools \[MCP入口：bosun\]/)
    assert.match(text(result), /下一步：先 action=describe, name="mcp__bosun__search_tools"/)
    assert.ok(!text(result).includes('call_endpoint'))
    assert.ok(!text(result).includes('delete_endpoint'))
    assert.ok(!text(result).includes('mcp__native__'))
  }
  assert.equal(f.calls(), 0)
  let snapshot = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(snapshot.activity.stats.searchMisses, 3)
  assert.ok(snapshot.activity.events.every(x => x.matchCount === 0 && x.candidates.length === 2))
  assert.match(text(await f.invoke({ action: 'search', query: 'grafana', kind: 'skill' })), /not_found:/)
  f.agent.ctx.tools.restrict({ deny: ['mcp__bosun__search_tools', 'mcp__bosun__list_endpoints'] })
  assert.match(text(await f.invoke({ action: 'search', query: 'grafana', kind: 'mcp' })), /not_found:/)
  assert.equal(f.calls(), 0)
})

test('explicit service keywords rank only visible routing entries; native services stay outside the gateway', async t => {
  const f = await setup(t, { mcpServers: ['alpha', 'catalog'], mcpKeywords: { catalog: ['grafana', 'metabase', 'purser', '监控平台'], native: ['grafana'] } })
  await skill(f.skillRoot, 'grafana', 'A managed skill for dashboard diagnosis')
  f.registerTool('mcp__alpha__search_tools')
  f.registerTool('mcp__catalog__search_tools')
  f.registerTool('mcp__catalog__list_endpoints')
  f.registerTool('mcp__catalog__call_endpoint')
  f.registerTool('mcp__native__search_tools')
  for (const query of ['grafana', 'metabase', 'purser', '监控平台', '请检查grafana生产环境过去七天的错误日志并给出分析']) {
    const result = await f.invoke({ action: 'search', query, kind: 'mcp' })
    assert.ok(!result.isError, text(result))
    assert.ok(!text(result).includes('无直接匹配'))
    const first = text(result).split('\n').find(x => x.startsWith('- '))
    assert.match(first, /mcp__catalog__search_tools \[MCP入口：catalog\]/)
    assert.match(text(result), /服务关键词仅定位到 MCP 入口，尚未查询下游服务/)
    assert.ok(!text(result).includes('mcp__native__'))
    assert.ok(!text(result).includes('call_endpoint'))
    assert.ok(!text(result).includes('mcp__alpha__'))
  }
  const mixed = await f.invoke({ action: 'search', query: 'grafana' })
  assert.match(text(mixed), /grafana \[技能\]/)
  assert.ok(!text(mixed).includes('action=describe, name="grafana"'))
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(activity.stats.searchMisses, 0)
  assert.equal(f.calls(), 0)
  f.agent.ctx.tools.restrict({ deny: ['mcp__catalog__search_tools', 'mcp__catalog__list_endpoints'] })
  const restricted = text(await f.invoke({ action: 'search', query: 'grafana', kind: 'mcp' }))
  assert.match(restricted, /无直接匹配/)
  assert.ok(!restricted.includes('mcp__catalog__'))
})

test('malformed explicit keyword mappings fail visibly instead of silently changing routing', () => {
  for (const keywords of [null, [], { catalog: 'grafana' }, { catalog: [42] }, { catalog: [''] }, { catalog: ['x'.repeat(81)] }, { 'invalid server': ['grafana'] }]) {
    assert.throws(() => gateway.apply({}, { enabled: false, mcpKeywords: keywords }), /invalid_config: mcpKeywords/)
  }
})

test('routing fallback is limited to short keyword queries and never diverts unmatched spreadsheet tasks', async t => {
  const f = await setup(t)
  f.registerTool('mcp__bosun__search_tools')
  f.registerTool('mcp__bosun__list_endpoints')
  for (const query of ['把这份 Excel 拆成多个 sheet 并核对公式', 'Excel 拆 sheet', 'Excel拆sheet',
    '这是一个没有空格但需要处理表格并核对公式的长任务描述', 'unknown service keyword', 'a'.repeat(25), '!!!']) {
    const result = await f.invoke({ action: 'search', query })
    assert.ok(result.isError, `${query}: ${text(result)}`)
    assert.match(text(result), /not_found:.*原生.*按原方式.*短关键词/)
    assert.ok(!text(result).includes('mcp__bosun__'))
    assert.ok(!text(result).includes('下一步：'))
  }
  for (const query of ['grafana', 'metabase', 'purser', 'unknown service', 'a'.repeat(24)]) {
    const result = await f.invoke({ action: 'search', query })
    assert.ok(!result.isError, `${query}: ${text(result)}`)
    assert.match(text(result), /无直接匹配/)
    assert.match(text(result), /mcp__bosun__search_tools/)
  }
  const direct = await f.invoke({ action: 'search', query: '请用 Echo diagnostic fixture 查询并检查当前环境中的工具' })
  assert.ok(!direct.isError, text(direct))
  assert.ok(!text(direct).includes('无直接匹配'))
  assert.equal(f.calls(), 0)
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(activity.stats.searchMisses, 12)
  assert.equal(activity.events.filter(x => x.matchCount === 0 && !x.candidates.length).length, 7)
})

test('fallback does not mask discovery failures or imply an unregistered MCP is available; load errors use Chinese', async t => {
  const f = await setup(t, { skillRoots: ['/nonexistent/dsh-gateway-fallback-root'] })
  f.registerTool('mcp__bosun__search_tools')
  const partial = await f.invoke({ action: 'search', query: 'grafana' })
  assert.ok(!partial.isError, text(partial))
  assert.match(text(partial), /发现不完整.*dependency_missing/)
  assert.equal(partial.value.discovery.complete, false)
  assert.ok(!(await f.invoke({ action: 'search', query: 'grafana', kind: 'mcp' })).isError)
  const empty = await setup(t, { wrapMcp: false })
  empty.registerTool('mcp__bosun__search_tools')
  assert.match(text(await empty.invoke({ action: 'search', query: 'grafana' })), /not_found:/)
  assert.match(text(await empty.invoke({ action: 'load', name: 'unknown-skill' })), /not_found: 网关内没有.*原生.*按原方式/)
  assert.match(text(await empty.invoke({ action: 'load' })), /not_found: action=load 需要/)
})

test('unknown identifiers cannot be masked by logs; Chinese matches and short routing fallback retain their boundaries', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'passport-debug', 'Diagnose FoloToy AI Passport runtime failures from logs and stack faults.')
  let calls = 0
  const description = '搜索账单、余额、日志相关工具。'
  const register = () => f.ctx.tools.register({ name: 'mcp__bosun__search_tools', description,
    parameters: { type: 'object' }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { calls++; return 'ok' } })
  register()
  f.registerTool('mcp__bosun__list_endpoints')
  for (const query of ['grafana logs', 'metabase logs', 'purser logs']) {
    const result = await f.invoke({ action: 'search', query })
    assert.ok(!result.isError, text(result))
    assert.match(text(result), /无直接匹配/)
    assert.match(text(result), /mcp__bosun__search_tools/)
    assert.ok(!text(result).includes('passport-debug'))
  }
  const skillsOnly = await f.invoke({ action: 'search', query: 'grafana logs', kind: 'skill' })
  assert.ok(skillsOnly.isError)
  assert.match(text(skillsOnly), /not_found:/)
  const long = await f.invoke({ action: 'search', query: '请检查 grafana logs 并分析生产环境过去七天的异常原因' })
  assert.ok(long.isError)
  assert.match(text(long), /not_found:/)
  assert.ok(!text(long).includes('passport-debug'))
  assert.ok(!text(long).includes('mcp__bosun__'))
  for (const query of ['账单 余额', '余额', '查生产环境错误日志']) {
    const result = await f.invoke({ action: 'search', query })
    assert.ok(!result.isError, text(result))
    assert.ok(!text(result).includes('无直接匹配'))
    assert.match(text(result), /mcp__bosun__search_tools/)
  }
  // A generic task word alone must not smuggle in one specific skill; the model gets routing entries instead.
  const logsOnly = await f.invoke({ action: 'search', query: 'logs', kind: 'skill' })
  assert.ok(logsOnly.isError)
  assert.match(text(logsOnly), /not_found:/)
  assert.equal(calls, 0)
  assert.equal(f.calls(), 0)
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(activity.stats.searchMisses, 6)
})

test('Host snapshot forwards anchored pagination while preserving whole-scope call statistics', async t => {
  const f = await setup(t)
  f.registerTool()
  for (let index = 0; index < 5; index++) await f.invoke({ action: 'call', name: 'mcp__bosun__echo', arguments: {} })
  const service = f.ctx.get('capabilityGateway')
  const first = (await service.snapshot({ limit: 2, offset: 0 })).activity
  const second = (await service.snapshot({ limit: 2, offset: 2, anchorId: first.anchorId })).activity
  assert.equal(first.total, 5)
  assert.equal(second.events.length, 2)
  assert.ok(second.events.every(event => !first.events.some(old => old.id === event.id)))
  assert.equal(second.stats.calls, 5)
  assert.equal(second.stats.callSuccessRate, 1)
  const last = (await service.snapshot({ limit: 2, offset: 4, anchorId: first.anchorId })).activity
  assert.equal(last.events.length, 1)
  await assert.rejects(service.snapshot({ anchorId: 'unknown-page-anchor' }), /not_found: history anchor expired/)
})

test('a search that displayed no candidates does not book later calls as adoption', async t => {
  const f = await setup(t)
  f.registerTool()
  const miss = await f.invoke({ action: 'search', query: '把这份 Excel 拆成多个 sheet 并核对公式' })
  assert.ok(miss.isError, text(miss))
  assert.ok(!(await f.invoke({ action: 'call', name: 'mcp__bosun__echo', arguments: { value: 'ok' } })).isError)
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  assert.equal(activity.stats.correlatedSelections, 0)
  assert.equal(activity.stats.explicitOrUnlinked, 1)
  assert.equal(activity.stats.candidateAdoptionRate, null)
  const call = activity.events.find(x => x.action === 'call')
  assert.equal(call.searchId, null)
  assert.equal(call.candidateRank, null)
})

test('a queryless search lists names without claiming a match', async t => {
  const f = await setup(t)
  f.registerTool()
  await f.registerTool('mcp__bosun__list_endpoints')
  const result = await f.invoke({ action: 'search', query: '   ' })
  assert.ok(!result.isError, text(result))
  assert.match(text(result), /未提供查询词，按名称列出 2 项（共 2 项已接管能力）。/)
  assert.ok(!/匹配 \d+ 项/.test(text(result)))
  const { activity } = await f.ctx.get('capabilityGateway').snapshot()
  const search = activity.events.find(x => x.action === 'search')
  assert.equal(search.matchCount, null)
  assert.equal(search.candidates.length, 2)
  assert.equal(activity.stats.searchMisses, 0)
})

test('report action exports a weekly summary without recording itself', async t => {
  const f = await setup(t)
  f.registerTool()
  await f.invoke({ action: 'call', name: 'mcp__bosun__echo', arguments: { value: 'ok' } })
  const before = (await f.ctx.get('capabilityGateway').snapshot()).activity
  const output = text(await f.invoke({ action: 'report' }))
  assert.match(output, /^# 能力网关周报/)
  assert.match(output, /运行插件版本：\d+\.\d+\.\d+/)
  assert.match(output, /实际转发 1/)
  const after = (await f.ctx.get('capabilityGateway').snapshot()).activity
  assert.equal(after.stats.operations, before.stats.operations)
  assert.ok(after.events.every(row => row.action !== 'report'))
  assert.match(before.events.find(row => row.action === 'call').plugin, /^\d+\.\d+\.\d+$/)
})

test('skill aliases carry a Chinese query to an English description', async t => {
  const configured = await setup(t, { skillKeywords: { 'passport-debug': ['看门狗', '黑屏'] } })
  await skill(configured.skillRoot, 'passport-debug', 'Diagnose runtime failures from logs and stack faults.')
  assert.match(text(await configured.invoke({ action: 'search', query: '黑屏 重启' })), /passport-debug/)
  const declared = await setup(t)
  await skill(declared.skillRoot, 'firmware-pack', 'Build and package firmware', 'keywords:\n  - 固件\n  - 打包\n')
  const result = text(await declared.invoke({ action: 'search', query: '固件 打包' }))
  assert.match(result, /firmware-pack/, result)
})

test('the prompt carries a bounded capability index instead of the full catalog', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'firmware-pack', 'Build and package firmware')
  f.registerTool('mcp__bosun__echo')
  await f.invoke({ action: 'search', query: 'firmware' })
  const section = (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'capability-gateway')
  assert.match(section.text, /firmware-pack/)
  assert.match(section.text, /mcp__bosun__echo/)
  assert.ok(section.text.length < 2000)
  const capped = await setup(t, { promptIndexChars: 200 })
  for (let index = 0; index < 20; index++) await skill(capped.skillRoot, `long-skill-name-${index}`, 'Filler skill')
  await capped.invoke({ action: 'search', query: 'filler' })
  const small = (await capped.ctx.systemPrompt.assemble({ scope: capped.agent })).sections.find(x => x.name === 'capability-gateway')
  assert.match(small.text, /…\+\d+ more/)
  assert.ok(small.text.length < 700)
})

test('promptIndex false keeps only the pointer hint', async t => {
  const f = await setup(t, { promptIndex: false })
  await skill(f.skillRoot, 'firmware-pack', 'Build and package firmware')
  await f.invoke({ action: 'search', query: 'firmware' })
  const section = (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'capability-gateway')
  assert.ok(!section.text.includes('firmware-pack'))
  assert.match(section.text, /capability/)
})

test('shared keyword packs are merged and inline config wins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-pack-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'first.json')
  const second = join(root, 'second.json')
  await writeFile(first, JSON.stringify({ 'firmware-pack': ['固件'], 'ghost-skill': ['幽灵'] }))
  await writeFile(second, JSON.stringify({ 'firmware-pack': ['打包'], 'pack-only': ['只在这里'] }))
  const f = await setup(t, { keywordPacks: [first, second], skillKeywords: { 'firmware-pack': ['专属'] } })
  await skill(f.skillRoot, 'firmware-pack', 'Build and package firmware images')
  for (const [query, word] of [['固件', '固件'], ['打包', '打包'], ['专属', '专属']]) {
    assert.match(text(await f.invoke({ action: 'search', query })), /firmware-pack/, `${word} should reach the skill`)
  }
})

test('cold prompt index follows scoped winners and never shares another agent skill names', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'firmware-pack', 'Build firmware')
  await skill(f.skillRoot, 'manual-only', 'Manual skill', 'disable-model-invocation: true\n')
  const hint = async agent => (await f.ctx.systemPrompt.assemble({ scope: agent })).sections.find(x => x.name === 'capability-gateway').text
  assert.match(await hint(f.agent), /firmware-pack/)
  assert.ok(!(await hint(f.agent)).includes('manual-only'))
  const release = f.agent.ctx.skills.register({ name: 'firmware-pack', source: 'project-dsh', description: 'Project winner', content: 'Project content' })
  assert.ok(!(await hint(f.agent)).includes('firmware-pack'))
  assert.ok((await f.invoke({ action: 'load', name: 'firmware-pack' })).isError)
  release()
  assert.match(await hint(f.agent), /firmware-pack/)
  assert.ok(!(await f.invoke({ action: 'load', name: 'firmware-pack' })).isError)
  const other = { session: { id: 'unmanaged-agent' } }
  other.ctx = createScope(f.ctx, other).ctx
  const [managed, unmanaged, host] = await Promise.all([hint(f.agent), hint(other), hint(undefined)])
  assert.match(managed, /firmware-pack/)
  assert.ok(!unmanaged.includes('firmware-pack'))
  assert.ok(!host.includes('firmware-pack'))
})

test('failed skill index is explicitly incomplete while scoped MCP index remains usable', async t => {
  const f = await setup(t, { skillRoots: ['/nonexistent/gateway-index-fixture'] })
  f.registerTool()
  const hint = (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'capability-gateway').text
  assert.match(hint, /Skill name index incomplete \(dependency_missing\)/)
  assert.match(hint, /mcp__bosun__echo/)
  assert.ok(!hint.includes('/nonexistent/'))
  assert.ok(!(await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })).isError)
})

test('explicit scope and skill alias configuration is validated before normalization', () => {
  for (const value of [null, [], { workflow: 'alias' }, { workflow: [42] }, { workflow: [''] }, { workflow: ['x'.repeat(81)] }, { workflow: Array(51).fill('word') }]) {
    assert.throws(() => gateway.apply({}, { enabled: false, skillKeywords: value }), /invalid_config: skillKeywords/)
  }
  for (const config of [{ skillRoots: 'path' }, { skillRoots: [42] }, { skillRoots: [''] }, { mcpServers: 'server' }, { mcpServers: ['invalid name'] }]) {
    assert.throws(() => gateway.apply({}, { enabled: false, ...config }), /invalid_config:/)
  }
})

test('alias diagnostics preserve valid entries and expose only bounded metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-alias-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const broken = join(root, 'private-broken.json')
  const mixed = join(root, 'mixed.json')
  await writeFile(broken, 'private-invalid-json-secret')
  await writeFile(mixed, JSON.stringify({ 'firmware-pack': ['固件'], invalid: [42] }))
  const f = await setup(t, { keywordPacks: [broken, mixed, ...Array.from({ length: 12 }, (_, i) => join(root, `missing-${i}`))] })
  await skill(f.skillRoot, 'firmware-pack', 'Build firmware')
  assert.match(text(await f.invoke({ action: 'search', query: '固件' })), /firmware-pack/)
  const { inventory } = await f.ctx.capabilityGateway.snapshot()
  const diagnostics = inventory.configDiagnostics
  assert.equal(diagnostics.complete, false)
  assert.equal(diagnostics.total, 14)
  assert.equal(diagnostics.items.length, 10)
  assert.equal(diagnostics.truncated, true)
  assert.deepEqual(diagnostics.items.slice(0, 3), [{ source: 'keywordPacks', index: 1, code: 'invalid_json' }, { source: 'keywordPacks', index: 2, code: 'invalid_entries', count: 1, entries: [2] }, { source: 'keywordPacks', index: 3, code: 'file_missing' }])
  const model = JSON.parse(text(await f.invoke({ action: 'inventory', kind: 'skill' })))
  assert.equal(model.complete, false)
  assert.deepEqual(model.configDiagnostics, diagnostics)
  assert.match(text(await f.invoke({ action: 'status' })), /14 alias warning/)
  const hint = (await f.ctx.systemPrompt.assemble({ scope: f.agent })).sections.find(x => x.name === 'capability-gateway').text
  assert.match(hint, /search coverage is incomplete/)
  assert.ok(!JSON.stringify(diagnostics).includes(root))
  assert.ok(!JSON.stringify(diagnostics).includes('private-invalid-json-secret'))
})

test('valid long explicit aliases are not silently shortened or discarded', async t => {
  const words = Array.from({ length: 21 }, (_, i) => `alias${i}`)
  words.push('x'.repeat(60))
  const f = await setup(t, { skillKeywords: { 'firmware-pack': words } })
  await skill(f.skillRoot, 'firmware-pack', 'Build firmware')
  for (const query of [words[20], words[21]]) assert.match(text(await f.invoke({ action: 'search', query })), /firmware-pack/)
  assert.equal((await f.ctx.capabilityGateway.snapshot()).inventory.configDiagnostics.complete, true)
})

test('alias file shape and read errors stay visible until a corrected configuration is reloaded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-alias-repair-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'aliases.json')
  await writeFile(path, '[]')
  const f = await setup(t, { keywordPacks: [path, root] })
  const diagnostics = async () => (await f.ctx.capabilityGateway.snapshot()).inventory.configDiagnostics
  assert.deepEqual((await diagnostics()).items.map(x => x.code), ['invalid_pack', 'file_unreadable'])
  await writeFile(path, JSON.stringify({ 'firmware-pack': ['固件'] }))
  assert.equal((await diagnostics()).complete, false, 'file edits alone must not erase the loaded configuration diagnosis')
  await skill(f.skillRoot, 'firmware-pack', 'Build firmware')
  await f.fiber.dispose()
  await f.ctx.plugin(gateway, { skillRoots: [f.skillRoot], mcpServers: ['bosun'], keywordPacks: [path], localAliases: false, logDir: join(f.root, 'reloaded-log') }).await()
  assert.deepEqual(await diagnostics(), { complete: true, total: 0, shown: 0, truncated: false, items: [] })
  assert.match(text(await f.invoke({ action: 'search', query: '固件' })), /firmware-pack/)
})

test('exact skill names bypass stop words only within the visible kind and scope', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'logs', 'Collect application logs')
  assert.match(text(await f.invoke({ action: 'search', query: 'LOGS', kind: 'skill' })), /logs \[技能\]/)
  assert.ok(!(await f.invoke({ action: 'load', name: 'logs' })).isError)
  assert.ok((await f.invoke({ action: 'search', query: 'logs', kind: 'mcp' })).isError)
  f.agent.ctx.skills.register({ name: 'logs', description: 'Personal logs', source: 'project-dsh', content: 'Keep personal' })
  assert.ok((await f.invoke({ action: 'search', query: 'logs', kind: 'skill' })).isError)
})

test('partial discovery preserves useful results without claiming a complete search or a miss', async t => {
  const f = await setup(t, { skillRoots: ['/nonexistent/dsh-gateway-partial-fixture'] })
  f.registerTool()
  const partial = await f.invoke({ action: 'search', query: 'mcp__bosun__echo' })
  assert.ok(!partial.isError, text(partial))
  assert.deepEqual(partial.value.discovery, { complete: false, unavailable: [{ kind: 'skill', code: 'dependency_missing' }] })
  assert.match(text(partial), /发现不完整/)
  const status = await f.invoke({ action: 'status' })
  assert.ok(!status.isError, text(status))
  assert.match(text(status), /skills: unknown/)
  assert.match(text(status), /bosun: 1 tools/)
  const unknown = await f.invoke({ action: 'search', query: 'this sufficiently long unknown query should never use a fallback' })
  assert.ok(unknown.isError)
  assert.match(text(unknown), /dependency_missing:.*不能判定为未命中/)
  const { activity } = await f.ctx.capabilityGateway.snapshot()
  assert.equal(activity.stats.searchIncomplete, 2)
  assert.equal(activity.stats.searchMisses, 0)
  assert.equal(activity.stats.searchFallbacks, 0)
  assert.ok(activity.events.filter(x => x.action === 'search').every(x => x.discoveryIncomplete))
})

test('MCP discovery failure leaves managed skills searchable and status reports unknown rather than zero', async t => {
  const f = await setup(t)
  await skill(f.skillRoot, 'logs', 'Collect logs')
  const schemas = f.ctx.tools.schemas
  f.ctx.tools.schemas = () => { throw new Error('unavailable: private registry failure') }
  try {
    const partial = await f.invoke({ action: 'search', query: 'logs' })
    assert.ok(!partial.isError, text(partial))
    assert.deepEqual(partial.value.discovery.unavailable, [{ kind: 'mcp', code: 'unavailable' }])
    const status = await f.invoke({ action: 'status' })
    assert.ok(!status.isError, text(status))
    assert.match(text(status), /bosun: unknown/)
    assert.ok(!text(status).includes('private registry failure'))
  } finally { f.ctx.tools.schemas = schemas }
})

test('Host report scopes match the selected agent and never widen invalid selections', async t => {
  const f = await setup(t)
  f.registerTool()
  await f.invoke({ action: 'call', name: 'mcp__bosun__echo' })
  const selected = await f.ctx.capabilityGateway.report({ format: 'json', historyScope: 'selected', agentId: 'fixture-agent' })
  const report = JSON.parse(selected.content)
  assert.deepEqual(report.scope, { kind: 'agent', agentId: 'fixture-agent' })
  assert.equal(report.stats.calls, 1)
  assert.match(text(await f.invoke({ action: 'report' })), /报告范围：会话 fixture-agent/)
  assert.deepEqual(JSON.parse((await f.ctx.capabilityGateway.report({ format: 'json' })).content).scope, { kind: 'all', agentId: null })
  for (const options of [{ historyScope: 'selected' }, { historyScope: 'all', agentId: 'fixture-agent' }, { historyScope: 'invalid' }]) await assert.rejects(f.ctx.capabilityGateway.report(options), /invalid_arguments/)
  await assert.rejects(f.ctx.capabilityGateway.report({ historyScope: 'selected', agentId: 'gone-agent' }), /not_found/)
  await f.ctx.plugin({ apply(ctx) { ctx.provide('sessionTitle', { get: session => ({ title: session.id === 'fixture-agent' ? 'Inspect deployment' : 'Other' }) }) } }).await()
  assert.equal((await f.ctx.capabilityGateway.snapshot()).agents[0].title, 'Inspect deployment')
})
