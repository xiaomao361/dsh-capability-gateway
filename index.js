/**
 * Capability gateway — one on-demand entry for opt-in third-party skills and MCP tools.
 *
 * Native reuse:
 * - MCP discovery and execution remain native. Native tool schemas are filtered
 *   at prompt assembly; dispatch retains the calling agent, token and guards.
 *   PTC SDK declarations use the host renderer with only unmanaged schemas.
 * - Per-agent skill providers hide opted-in skills while retaining the native
 *   project/runtime/personal precedence and explicit user invocation.
 *
 * Nothing is managed unless listed in config; disabled or unwrapped capabilities
 * keep their original native exposure.
 */

import { watch, readFileSync } from 'node:fs'
import { readFile, readdir, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { randomUUID } from 'node:crypto'
import { EventJournal, ACTIONS, errorCode, hasErrorCode } from './observability.js'
import { registerRemote } from './remote.js'
import { rankCapabilities, preview, routingEntries, allowsRoutingFallback } from './search.js'
import { createArgumentValidator } from './validation.js'
import { buildReport, reportFilename } from './report.js'

const PROVIDER = 'capability-gateway'
// Stamped onto every recorded event so a weekly report can separate what was
// observed before and after a rule change. Read from the packaged manifest;
// an unreadable manifest records `unknown` instead of failing the plugin.
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? null } catch { return null }
})()
const TOOL_NAME = 'capability'
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_DESCRIPTION = 500

export const inject = ['tools', 'skills', 'systemPrompt']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  if (!config.enabled) {
    ctx.logger?.info?.('capability gateway disabled by config; native exposure retained')
    return
  }

  const validateArguments = createArgumentValidator()
  // Presentation adapter only: never replace methods on the live registry or
  // restrict execution to hide declarations. Older hosts retain their SDK and
  // report native-sdk explicitly. Rendering errors still fail prompt assembly.
  const ptcSdkSupported = ['sdkSection', 'sdkSchemas', 'modeFor', 'requirePtcRuntime'].every(key => typeof ctx.tools[key] === 'function')
  const ptcSdkSection = ptcSdkSupported ? ctx.tools.sdkSection.call({
    ctx: ctx.tools.ctx,
    modeFor: scope => ctx.tools.modeFor(scope),
    requirePtcRuntime: mode => ctx.tools.requirePtcRuntime(mode),
    sdkSchemas: scope => ctx.tools.sdkSchemas(scope).filter(schema => !serverOf(schema.name)),
  }) : null
  const controls = new Set()
  let skillCache = { at: 0, skills: [], error: undefined }

  const journal = new EventJournal(config.logDir, { pluginVersion: PLUGIN_VERSION })
  const traces = new WeakMap()
  const directStarts = new WeakMap()
  const dispatches = new WeakMap()
  const searches = new WeakMap()
  const unscoped = {}
  const identity = exec => exec.agent?.session?.id ?? exec.agent?.id ?? null
  const traceOf = exec => exec?.token && traces.get(exec.token)
  const setTarget = (exec, target, kind) => {
    const trace = traceOf(exec)
    if (trace) Object.assign(trace, { target, kind })
  }

  ctx.on('tools/pre-execute', (exec, next) => {
    if (serverOf(exec.name) || exec.name === 'skill') directStarts.set(exec.token, performance.now())
    if (exec.name === TOOL_NAME) {
      traces.set(exec.token, {
        id: randomUUID(), action: ACTIONS.has(exec.arguments?.action) ? exec.arguments.action : 'invalid',
        agentId: identity(exec), callId: exec.callId, route: 'gateway',
        start: performance.now(), at: Date.now(), candidates: [],
      })
    }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    const parent = exec.parent && traces.get(exec.parent)
    const tracked = serverOf(exec.name)
    if (parent && parent.action === 'call') parent.dispatched = true
    try { return await next() }
    finally {
      if (parent && parent.action === 'call') parent.actualTarget = exec.name
      if (tracked) dispatches.set(exec.token, exec.name)
    }
  })
  ctx.on('tools/result', (exec, result) => {
    const nested = exec.parent && traces.get(exec.parent)
    if (nested && nested.action === 'call') return
    const isGateway = exec.name === TOOL_NAME
    const managedMcp = config.wrapMcp && serverOf(exec.name)
    const knownMcp = managedMcp && (dispatches.has(exec.token) || ctx.tools.get(exec.name, exec.agent))
    const managedSkill = exec.name === 'skill' && skillCache.skills.some(x => x.name === exec.arguments?.name)
    if (!isGateway && !managedMcp && !managedSkill) return
    const trace = traceOf(exec) ?? {
      id: randomUUID(), action: isGateway ? (ACTIONS.has(exec.arguments?.action) ? exec.arguments.action : 'invalid') : (managedSkill ? 'load' : 'call'),
      route: isGateway ? 'gateway' : 'direct', at: Date.now(), agentId: identity(exec), callId: exec.callId,
      ...(managedMcp ? { target: knownMcp ? exec.name : null, actualTarget: dispatches.get(exec.token) ?? null, kind: 'mcp', dispatched: dispatches.has(exec.token) } : {}),
      ...(managedSkill ? { target: exec.arguments.name, kind: 'skill' } : {}),
    }
    if (['status', 'inventory', 'history', 'stats', 'report'].includes(trace.action)) return
    trace.at = Date.now()
    trace.outcome = exec.signal?.aborted ? 'cancelled' : result.isError ? 'error' : 'success'
    trace.errorCode = trace.outcome === 'cancelled' ? 'cancelled' : result.isError
      ? errorCode(result.error?.message ?? contentText(result)) : null
    const started = trace.start ?? directStarts.get(exec.token)
    trace.durationMs = started === undefined ? null : performance.now() - started
    const key = exec.agent ?? unscoped
    if (trace.action === 'search' && isGateway) {
      searches.set(key, { id: trace.id, at: Date.now(), candidates: trace.candidates ?? [] })
    } else if (trace.target && ['load', 'call', 'describe'].includes(trace.action)) {
      const search = searches.get(key)
      // A search that displayed nothing cannot be "adopted"; linking to it would
      // book an unrelated later choice into the adoption denominator as rank 0.
      if (search && search.candidates.length && Date.now() - search.at <= 10 * 60 * 1000) {
        trace.searchId = search.id
        trace.candidateRank = search.candidates.findIndex(x => x.name === trace.target && x.kind === trace.kind) + 1
      }
    }
    journal.record(trace)
    traces.delete(exec.token)
  })
  ctx.effect(() => () => journal.flush())

  // ── skill discovery ────────────────────────────────────────────────────────

  async function scanSkills(roots = config.skillRoots) {
    const skills = []
    const seen = new Set()
    for (const root of roots) {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch (error) {
        throw new Error(`dependency_missing: cannot scan skill root ${root} (${message(error)})`)
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        let file
        let baseDir = root
        const kind = entry.isSymbolicLink() ? await stat(join(root, entry.name)) : entry
        if (kind.isDirectory()) {
          file = join(root, entry.name, 'SKILL.md')
          baseDir = join(root, entry.name)
        } else if (kind.isFile() && entry.name.endsWith('.md')) {
          file = join(root, entry.name)
        } else {
          continue
        }
        let text
        try {
          text = await readFile(file, 'utf8')
        } catch (error) {
          if (error.code === 'ENOENT') continue
          throw new Error(`dependency_missing: cannot read ${file} (${message(error)})`)
        }
        let data
        try { ({ data } = parseFrontmatter(text)) }
        catch (error) { throw new Error(`dependency_missing: invalid skill frontmatter in ${file} (${message(error)})`) }
        const name = typeof data.name === 'string' ? data.name : ''
        if (!SKILL_NAME_RE.test(name) || seen.has(name)) continue
        for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
          if (Object.hasOwn(data, key)) throw new Error(`dependency_missing: unsupported invocation key ${key} in ${file}`)
        }
        const policy = (key, fallback) => {
          if (!Object.hasOwn(data, key)) return fallback
          const value = boolish(data[key], undefined)
          if (value === undefined) throw new Error(`dependency_missing: invalid boolean ${key} in ${file}`)
          return value
        }
        if (policy('disable-model-invocation', false)) continue
        const description = bound(data.description)
        if (!description) continue
        seen.add(name)
        skills.push({
          name,
          description,
          whenToUse: bound(data.whenToUse),
          // Optional bilingual aliases: a Chinese query cannot reach an English
          // description, so the skill may declare its own searchable synonyms.
          keywords: normalizeKeywordList(data.keywords),
          userInvocable: policy('user-invocable', true),
          metadata: data.metadata,
          path: file,
          baseDir,
          root,
        })
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name))
    return skills
  }

  async function managedSkills() {
    if (!config.wrapSkills || config.skillRoots.length === 0) return []
    if (Date.now() - skillCache.at < 2000) {
      if (skillCache.error) throw skillCache.error
      return skillCache.skills
    }
    try {
      const skills = await scanSkills()
      skillCache = { at: Date.now(), skills, error: undefined }
      return skills
    } catch (error) {
      skillCache = { at: Date.now(), skills: skillCache.skills, error }
      throw error
    }
  }

  function invalidateSkills() {
    skillCache = { at: 0, skills: skillCache.skills, error: skillCache.error }
    for (const control of controls) {
      try {
        control.invalidate()
      } catch {
        // a stale registration's invalidate is a no-op by contract
      }
    }
  }

  // ── MCP discovery (native registry is the source of truth) ─────────────────

  function wrappedSchemas(exec) {
    if (!config.wrapMcp || config.mcpServers.length === 0) return []
    const prefixes = config.mcpServers.map((server) => `mcp__${server}__`)
    return ctx.tools.schemas(exec?.agent).filter((schema) => prefixes.some((prefix) => schema.name.startsWith(prefix)))
  }

  function serverOf(toolName) {
    for (const server of config.mcpServers) {
      if (toolName.startsWith(`mcp__${server}__`)) return server
    }
    return undefined
  }

  // Presentation is separate from authorization. Never restrict then dispatch
  // globally: that loses the caller's scoped policies and model/account context.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    const names = new Set(wrappedSchemas({ agent: context.scope }).map((tool) => tool.name))
    let index = []
    let indexError = null
    if (config.promptIndex) {
      try { index = (await visibleSkills({ agent: context.scope })).map(skill => skill.name) }
      catch (error) { indexError = errorCode(error) }
      index.push(...names)
    }
    return { ...result,
      tools: result.tools.filter((tool) => !names.has(tool.name)),
      sections: result.sections.map(section => {
        if (section.name === 'capability-gateway') return { ...section, text: promptText(index, indexError) }
        if (section.name === 'tools:sdk' && ctx.tools.modeFor(context.scope) !== 'native' && names.size && ptcSdkSection) return { ...section, text: ptcSdkSection.text(context) }
        return section
      }),
    }
  })

  // The provider registers on each agent's scoped context: a preset-layer
  // skill provider (dsh-skill-filesystem) sits nearer than the global layer and
  // wins duplicates outright, so a global overlay is never selected. Agent
  // scopes share that layer, where our candidate rank decides the winner.
  const skillDisposers = new Set()
  const installedSkills = new WeakSet()

  function installSkillProvider(agent) {
    if (!config.wrapSkills || !config.skillRoots.length) return
    if (installedSkills.has(agent)) return
    const skills = agent.ctx.get('skills')
    if (!skills) return
    installedSkills.add(agent)
    const dispose = skills.registerProvider((control) => {
      controls.add(control)
      control.signal.addEventListener('abort', () => controls.delete(control), { once: true })
      return {
        name: PROVIDER,
        async list(options = {}) {
          // A scoped overlay must not hide a protected global winner either.
          // The global view excludes our agent-scoped provider, so this does not recurse.
          const managed = await managedSkills()
          const paths = new Map(await Promise.all(managed.map(async item => [item.name, await realpath(item.path)])))
          const host = await ctx.skills.snapshot({ cwd: options.cwd, signal: options.signal })
          if (!host.complete) throw new Error('unavailable: global skill discovery is incomplete')
          const protectedNames = new Set(host.skills.filter(item =>
            !['user-agents', 'custom'].includes(item.source) || paths.get(item.name) !== item.path).map(item => item.name))
          return managed.filter(item => !protectedNames.has(item.name)).map((skill) => ({
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
            invocation: { modelInvocable: false, userInvocable: skill.userInvocable },
            source: skill.root === expandHome('~/.agents/skills') ? 'user-agents' : 'custom',
            provider: PROVIDER,
            path: skill.path,
            resourceBase: { kind: 'directory', path: skill.baseDir },
            rank: skill.root === expandHome('~/.agents/skills') ? 499 : 299,
            locator: { path: skill.path },
            ...(skill.metadata && typeof skill.metadata === 'object' ? { metadata: skill.metadata } : {}),
          }))
        },
        async get(candidate, options) {
          const text = await readFile(candidate.path, { encoding: 'utf8', signal: options.signal })
          const { body } = parseFrontmatter(text)
          return { ...candidate, content: body.trim() }
        },
      }
    })
    skillDisposers.add(dispose)
  }

  ctx.effect(() => {
    const off = ctx.on('agent/created', ({ agent }) => installSkillProvider(agent))
    const agents = ctx.get('agents')
    if (agents) {
      for (const agent of agents.list()) installSkillProvider(agent)
    }
    return () => {
      if (typeof off === 'function') off()
      for (const dispose of skillDisposers) {
        try {
          dispose()
        } catch {
          // the agent scope may already own it
        }
      }
      skillDisposers.clear()
    }
  })

  async function visibleSkills(exec) {
    const scanned = await managedSkills()
    if (!scanned.length) return []
    const workingDirectory = ctx.get('workingDirectory')
    const cwd = exec?.agent && workingDirectory
      ? await workingDirectory.ensure(exec.agent, exec.signal)
      : undefined
    const snapshot = await ctx.skills.snapshot({ scope: exec?.agent, cwd, signal: exec?.signal })
    if (!snapshot.complete) throw new Error('unavailable: native skill discovery is incomplete; retry after resolving its provider errors')
    const winners = new Set(snapshot.skills.filter((skill) => skill.provider === PROVIDER).map((skill) => skill.name))
    return scanned.filter((skill) => winners.has(skill.name))
  }

  // ── gateway tool ───────────────────────────────────────────────────────────

  async function discoverCapabilities(exec, kind) {
    const requested = kind ? [kind] : ['skill', 'mcp']
    const results = await Promise.allSettled(requested.map(group => Promise.resolve().then(() => group === 'skill' ? visibleSkills(exec) : wrappedSchemas(exec))))
    const discovery = { skills: [], mcp: [], unavailable: [] }
    results.forEach((result, index) => {
      const group = requested[index]
      if (result.status === 'fulfilled') discovery[group === 'skill' ? 'skills' : 'mcp'] = result.value
      else discovery.unavailable.push({ kind: group, code: errorCode(result.reason) })
    })
    return discovery
  }

  async function search(query, limit, exec, kind) {
    const { skills, mcp, unavailable } = await discoverCapabilities(exec, kind)
    const candidates = [
      ...skills.map(skill => ({ kind: 'skill', name: skill.name, detail: skill.description, whenToUse: skill.whenToUse,
        keywords: [...skill.keywords ?? [], ...config.skillKeywords.get(skill.name) ?? []] })),
      ...mcp.map(schema => ({ kind: 'mcp', name: schema.name, detail: schema.description, server: serverOf(schema.name) })),
    ]
    const entries = routingEntries(candidates)
    const entryMap = new Map(entries.map(item => [item.name, item]))
    for (const item of candidates) {
      const entry = entryMap.get(item.name)
      if (entry) Object.assign(item, { routingPriority: entry.routingPriority, keywords: config.mcpKeywords.get(item.server) ?? [] })
    }
    const scored = rankCapabilities(candidates, query)
    // No query is not a match: it lists names for orientation and must not look
    // like "N capabilities matched" in the answer or in the recorded statistics.
    const listing = !String(query ?? '').trim()
    const fallback = !scored.length && entries.length > 0 && allowsRoutingFallback(query)
    const top = (fallback ? entries : scored).slice(0, limit)
    const routingTarget = top.find(item => item.kind === 'mcp' && (fallback || item.keywordMatch))
    const trace = traceOf(exec)
    if (trace) Object.assign(trace, { candidates: top.map(({ kind, name }) => ({ kind, name })), matchCount: listing ? null : scored.length, discoveryIncomplete: unavailable.length > 0 })
    if (!top.length) {
      if (unavailable.length) throw new Error(`${unavailable[0].code}: 能力发现不完整（${unavailable.map(x => `${x.kind}: ${x.code}`).join('; ')}）；当前可用范围没有候选，不能判定为未命中。用 action=inventory 查看异常。`)
      throw new Error('not_found: 网关范围内无匹配；这里只搜索已接管的第三方能力，不代表 DSH 没有此能力。原生、项目或未纳入能力请按原方式使用。可缩小为能力名称或短关键词，或用 kind=skill|mcp 收窄；长任务描述不推荐通用 MCP 入口。查看完整接入清单请到设置 → 内置插件 → 能力网关。')
    }
    const text = [
      ...(unavailable.length ? [`发现不完整（${unavailable.map(x => `${x.kind}: ${x.code}`).join('; ')}）。以下仅为当前可用部分；缺失类别的能力未知。`] : []),
      listing ? `未提供查询词，按名称列出 ${top.length} 项（共 ${candidates.length} 项已接管能力）。`
        : fallback ? '无直接匹配。以下 MCP 入口可继续检索与路由，不代表已找到目标能力或确认下游可用。'
          : `网关范围内匹配 ${scored.length} 项，返回 ${top.length} 项。只含已接管能力；原生/未纳入能力按原方式使用。`,
      ...top.map(item => `- ${item.name} [${item.kind === 'skill' ? '技能' : `${fallback || item.keywordMatch ? 'MCP入口' : 'MCP服务'}：${item.server}`}] — ${preview(item.detail) || '暂无说明'}`),
      ...(top.some(item => item.keywordMatch) ? ['服务关键词仅定位到 MCP 入口，尚未查询下游服务。'] : []),
      routingTarget
        ? `下一步：先 action=describe, name="${routingTarget.name}" 查看参数，再按 schema 用 action=call 将原查询交给该入口继续检索；不自动调用。`
        : '技能：action=load；MCP：action=describe → call。可用 kind=skill|mcp 收窄。',
    ].join('\n')
    return { content: [{ type: 'text', text }], discovery: { complete: unavailable.length === 0, unavailable } }
  }

  async function describeTool(name, exec) {
    const schema = wrappedSchemas(exec).find((candidate) => candidate.name === name)
    if (!schema) {
      throw new Error(
        `unavailable: "${name}" is not a registered MCP tool of the wrapped servers right now. It may belong to another server or its connection is down.`,
      )
    }
    setTarget(exec, schema.name, 'mcp')
    return [
      `MCP tool ${schema.name} (server: ${serverOf(schema.name)})`,
      '',
      `Purpose: ${schema.description ?? '(no description)'}`,
      '',
      'Parameters (JSON Schema):',
      JSON.stringify(schema.parameters ?? { type: 'object', properties: {} }, null, 2),
      '',
      `Call it with action=call, name="${schema.name}", arguments={...}.`,
    ].join('\n')
  }

  async function loadSkill(name, exec) {
    if (!name) throw new Error('not_found: action=load 需要 name=<搜索结果中的技能名称>。这里只加载已接管技能；原生、项目或未纳入技能请按原方式使用。')
    const skill = (await visibleSkills(exec)).find((candidate) => candidate.name === name)
    if (!skill) {
      throw new Error(
        `not_found: 网关内没有名为“${name}”的已接管技能。请先 action=search；原生、项目或未纳入技能请按原方式使用，不代表 DSH 没有此能力。`,
      )
    }
    setTarget(exec, skill.name, 'skill')
    let text
    try {
      text = await readFile(skill.path, 'utf8')
    } catch (error) {
      throw new Error(`dependency_missing: 无法读取技能文件 ${skill.path}（${message(error)}）`)
    }
    const { body } = parseFrontmatter(text)
    if (!body.trim()) throw new Error(`dependency_missing: 技能“${name}”的指令正文为空`)
    return [
      `<skill_content name="${escapeAttribute(name)}">`,
      '<skill_resources>',
      `Base directory for this skill: ${skill.baseDir}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      body.trim(),
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n')
  }

  async function callTool(name, args, exec) {
    if (!name) throw new Error('invalid_arguments: name=<MCP tool name> from action=search')
    const schema = wrappedSchemas(exec).find((candidate) => candidate.name === name)
    if (!schema) {
      throw new Error(
        `unavailable: "${name}" is not currently registered by a wrapped MCP server. Search again; if the server is reconnecting, retry later.`,
      )
    }
    setTarget(exec, schema.name, 'mcp')
    validateArguments(schema.name, schema.parameters ?? { type: 'object', properties: {} }, args === undefined ? {} : args)
    const result = await ctx.tools.execute({
      callId: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      arguments: args ?? {},
      signal: exec.signal,
      agent: exec.agent,
      parent: exec.token,
      rootCallId: exec.rootCallId ?? exec.callId,
    })
    if (result.isError) throw new Error(`execution_failed: ${contentText(result) || 'the MCP server reported an error'}`)
    for (const context of result.additionalContexts ?? []) exec.deferContext(context)
    return result
  }

  async function inventory(exec = {}, kind) {
    const options = { scope: exec.agent, signal: exec.signal }
    const directory = ctx.get('workingDirectory')
    if (exec.agent && directory) options.cwd = await directory.ensure(exec.agent, exec.signal)
    const roots = await Promise.all((kind === 'mcp' ? [] : config.skillRoots).map(async root => {
      try {
        const skills = await scanSkills([root])
        return { path: root, state: 'readable', count: skills.length, skills }
      } catch (error) { return { path: root, state: 'error', count: null, errorCode: errorCode(error), skills: [] } }
    }))
    let native
    try { native = kind === 'mcp' ? { skills: [], complete: true } : await ctx.skills.snapshot(options) }
    catch { native = { skills: [], complete: false } }
    const scanned = new Map(roots.flatMap(root => root.skills.map(skill => [skill.name, skill])))
    const nativeNames = new Set(native.skills.map(skill => skill.name))
    const skills = native.skills.map(skill => ({
      name: skill.name, description: bound(skill.description, 240), source: skill.source, provider: skill.provider,
      path: skill.path ?? null,
      managed: skill.provider === PROVIDER,
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
      state: !native.complete ? 'unknown' : skill.provider === PROVIDER ? 'managed' : scanned.has(skill.name) ? 'native_override' : 'native',
    }))
    for (const [name, skill] of scanned) if (!nativeNames.has(name)) skills.push({
      name, description: skill.description, source: 'configured-root', provider: null, path: skill.path,
      managed: false, modelInvocable: null, userInvocable: skill.userInvocable, state: 'not_in_scope',
    })
    const configurations = new Map()
    const loaders = new Set([ctx.get('loader'), exec.agent?.ctx.get('loader')].filter(Boolean))
    for (const loader of kind === 'skill' ? [] : loaders) for (const entry of loader.entries()) {
      if (entry.options.name !== '@deepseek-ai/dsh-mcp-client') continue
      const raw = entry.options.config
      const server = raw?.serverName
      if (typeof server !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(server)) continue
      if (!configurations.has(server)) configurations.set(server, new Map())
      const registration = { entryId: entry.id, enabled: !entry.disabled,
        phase: ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'][entry.fiber?.state] ?? 'unobserved' }
      const entries = configurations.get(server)
      const previous = entries.get(entry.id)
      if (!previous) entries.set(entry.id, registration)
      else if (previous.enabled !== registration.enabled || previous.phase !== registration.phase) {
        previous.observations ??= [{ enabled: previous.enabled, phase: previous.phase }]
        if (!previous.observations.some(x => x.enabled === registration.enabled && x.phase === registration.phase)) previous.observations.push({ enabled: registration.enabled, phase: registration.phase })
        previous.conflict = true
        previous.enabled = previous.observations.every(x => x.enabled === false) ? false : true
        previous.phase = previous.observations.some(x => x.phase === 'failed') ? 'failed' : 'unobserved'
      }
    }
    const schemas = kind === 'skill' ? [] : ctx.tools.schemas(exec.agent)
    const groups = new Map([...new Set([...(kind === 'skill' ? [] : config.mcpServers), ...configurations.keys()])].map(server => [server, []]))
    for (const schema of schemas) {
      const match = /^mcp__(.*?)__/.exec(schema.name)
      if (!match) continue
      if (!groups.has(match[1])) groups.set(match[1], [])
      groups.get(match[1]).push({ name: schema.name, description: bound(schema.description, 240) ?? '' })
    }
    const registrations = server => [...(configurations.get(server)?.values() ?? [])]
    const mode = ctx.tools.modeFor(exec.agent)
    return {
      at: Date.now(), agentId: identity(exec), scope: exec.agent ? 'live-agent' : 'host-only', mode,
      nativeSkillsComplete: native.complete,
      configDiagnostics: config.diagnostics,
      mcpConfigurationObserved: loaders.size > 0,
      skillRoots: roots.map(({ skills, ...root }) => root),
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
      mcp: [...groups].map(([name, tools]) => ({
        name, managed: config.wrapMcp && config.mcpServers.includes(name),
        state: tools.length ? 'tools_registered' : registrations(name).length && registrations(name).every(x => x.enabled === false) ? 'disabled'
          : registrations(name).some(x => x.phase === 'failed') ? 'plugin_failed' : 'no_tools_observed',
        registrations: registrations(name),
        tools, toolCount: tools.length,
        presentation: !config.wrapMcp || !config.mcpServers.includes(name) ? 'native' : mode === 'native' ? 'gateway' : ptcSdkSupported ? 'gateway-sdk' : 'native-sdk',
      })),
    }
  }

  const liveAgents = () => ctx.get('agents')?.list() ?? []
  const agentTitle = agent => {
    try { return bound(ctx.get('sessionTitle')?.get(agent.session)?.title, 80) ?? null }
    catch { return null } // Optional display metadata; identity never depends on it.
  }
  registerRemote(ctx, {
    async snapshot(raw = {}) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_arguments: snapshot options must be an object')
      const options = raw
      if (options.agentId !== undefined && typeof options.agentId !== 'string') throw new Error('invalid_arguments: invalid agentId')
      for (const [key, allowed] of Object.entries({ historyScope: ['all', 'selected'], outcome: ['success', 'error', 'cancelled'], action: ['search', 'load', 'describe', 'call'] })) {
        if (options[key] !== undefined && !allowed.includes(options[key])) throw new Error(`invalid_arguments: invalid ${key}`)
      }
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500)) throw new Error('invalid_arguments: limit must be 1–500')
      if (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0 || options.offset > 10000)) throw new Error('invalid_arguments: offset must be 0–10000')
      if (options.anchorId !== undefined && (typeof options.anchorId !== 'string' || !options.anchorId.length || options.anchorId.length > 200)) throw new Error('invalid_arguments: invalid anchorId')
      const agents = liveAgents()
      const agent = options.agentId ? agents.find(x => identity({ agent: x }) === options.agentId) : agents[0]
      if (options.agentId && !agent) throw new Error('not_found: live agent no longer exists; refresh the session list')
      if (options.historyScope === 'selected' && !agent) throw new Error('not_found: no live agent selected; use all-session history')
      const [catalog, activity] = await Promise.all([
        inventory({ agent, signal: new AbortController().signal }),
        journal.snapshot({ agentId: options.historyScope === 'selected' ? identity({ agent }) : undefined,
          limit: options.limit, offset: options.offset, anchorId: options.anchorId, outcome: ['success', 'error', 'cancelled'].includes(options.outcome) ? options.outcome : undefined,
          action: ['search', 'load', 'describe', 'call'].includes(options.action) ? options.action : undefined }),
      ])
      return { inventory: catalog, activity,
        agents: agents.map(x => ({ id: identity({ agent: x }), title: agentTitle(x) })).filter(x => x.id),
        config: { wrapSkills: config.wrapSkills, wrapMcp: config.wrapMcp },
      }
    },
    async review(options) {
      if (!options || typeof options.eventId !== 'string') throw new Error('invalid_arguments: eventId is required')
      return journal.review(options.eventId, options.verdict)
    },
    async report(options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('invalid_arguments: report options must be an object')
      const format = options?.format ?? 'markdown'
      if (!['markdown', 'json'].includes(format)) throw new Error('invalid_arguments: format must be markdown or json')
      const scope = options.historyScope ?? 'all'
      if (!['all', 'selected'].includes(scope)) throw new Error('invalid_arguments: invalid report scope')
      if (scope === 'all' && options.agentId !== undefined) throw new Error('invalid_arguments: agentId requires selected report scope')
      if (scope === 'selected' && (typeof options.agentId !== 'string' || !options.agentId)) throw new Error('invalid_arguments: selected report scope requires agentId')
      if (scope === 'selected' && !liveAgents().some(agent => identity({ agent }) === options.agentId)) throw new Error('not_found: selected report agent no longer exists; refresh the session list')
      const summary = await journal.summary({ agentId: scope === 'selected' ? options.agentId : undefined })
      const report = buildReport(summary)
      return { format, filename: reportFilename(summary, format), generatedAt: summary.generatedAt,
        pluginVersion: summary.pluginVersion, scope: summary.scope, content: format === 'json' ? report.json : report.markdown }
    },
  })

  async function status(exec) {
    const { skills, mcp, unavailable } = await discoverCapabilities(exec)
    const mcpUnknown = unavailable.some(x => x.kind === 'mcp')
    const perServer = config.mcpServers.map((server) => {
      const count = mcp.filter((schema) => serverOf(schema.name) === server).length
      return `${server}: ${mcpUnknown ? 'unknown (discovery failed)' : count === 0 ? 'unavailable (no tools registered)' : `${count} tools`}`
    })
    const mode = ctx.tools.modeFor(exec?.agent)
    return [
      'Capability gateway: enabled',
      `discovery: ${unavailable.length ? `incomplete (${unavailable.map(x => `${x.kind}: ${x.code}`).join('; ')})` : 'complete'}`,
      'View inventory and routing activity in 设置 → 内置插件 → 能力网关.',
      `skills: ${unavailable.some(x => x.kind === 'skill') ? 'unknown (discovery failed)' : `${skills.length} managed`} from ${config.skillRoots.join(', ') || '(none)'} — model catalog hidden, user invocation kept`,
      `mcp: ${config.mcpServers.length} wrapped server(s) — ${perServer.join('; ') || '(none)'}`,
      `MCP presentation: ${mcpUnknown ? 'unknown (discovery failed)' : !config.wrapMcp ? 'native exposure (MCP wrapping disabled)' : mode === 'native' ? `${mcp.length} tools omitted from native schemas` : ptcSdkSupported ? `${mcp.length} tools omitted from PTC SDK declarations; use tools.capability inside run_code` : 'PTC SDK retains native tool exposure (host presentation API unsupported); gateway calls remain scoped'}`,
      `gateway tool: ${TOOL_NAME} (search / describe / load / call / status / inventory / history / stats / report)`,
      `report: ${PLUGIN_VERSION ? `version ${PLUGIN_VERSION} tags each event` : 'version unknown (package manifest unreadable); report rows stay unattributed'}`,
      `skill aliases: ${config.skillKeywords.size} skill(s) carry searchable synonyms`,
      `configuration: ${config.diagnostics.complete ? 'complete' : `${config.diagnostics.total} alias warning(s); inspect inventory configDiagnostics and reload after correction`}`,
      skillCache.error ? `last skill scan error: ${errorCode(skillCache.error)}` : 'last skill scan: ok',
    ].join('\n')
  }

  ctx.effect(() => {
    const watchers = []
    if (config.wrapSkills) {
      for (const root of config.skillRoots) {
        try {
          const watcher = watch(root, { persistent: false, recursive: true }, () => invalidateSkills())
          watcher.on('error', () => {})
          watchers.push(watcher)
        } catch {
          // a missing root is fine; it can appear later and scanning retries
        }
      }
    }

    return () => {
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // already closed
        }
      }
      controls.clear()
    }
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'Search and use opted-in third-party skills and MCP tools. Native catalogs are reduced; code-mode SDK exposure is reported by status. ' +
        'Actions: search finds candidates by goal; load returns a skill\'s full instructions plus its base directory; ' +
        'describe returns one MCP tool\'s exact schema; call invokes an MCP tool with JSON arguments; status gives a summary; inventory returns counts, roots and bounded anomalies; history/stats show this session\'s recent routing metadata. ' +
        'Search covers only opted-in capabilities; use native/project/unmanaged capabilities through their original entry points.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'load', 'describe', 'call', 'status', 'inventory', 'history', 'stats', 'report'],
            description: 'search: find capabilities; load: read a skill; describe/call: inspect/invoke MCP; status: summary; inventory: compact counts/roots/anomalies; history/stats: session routing activity; report: export a weekly summary.',
          },
          query: {
            type: 'string',
            description: 'search: what the task needs, in keywords or a short phrase (English or Chinese both work).',
          },
          name: {
            type: 'string',
            description: 'load/describe/call: exact skill name or MCP tool name returned by search.',
          },
          arguments: {
            type: 'object',
            additionalProperties: true,
            description: 'call: JSON arguments matching the describe result of the MCP tool.',
          },
          kind: {
            type: 'string', enum: ['skill', 'mcp'],
            description: 'search/inventory: restrict to skills or MCP; omit for both.',
          },
          limit: {
            type: 'number',
            description: 'search: maximum candidates; inventory: maximum anomalies (1-10, default 5).',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => value.content,
      },
      async execute(args, exec) {
        const action = String(args?.action ?? '')
        try {
          if (args?.kind !== undefined && !['skill', 'mcp'].includes(args.kind)) throw new Error('invalid_arguments: kind must be skill or mcp')
          let value
          switch (action) {
            case 'search':
              value = await search(args?.query, clampNumber(args?.limit, 1, 10, config.maxResults), exec, args?.kind)
              break
            case 'describe':
              value = await describeTool(String(args?.name ?? ''), exec)
              break
            case 'load':
              value = await loadSkill(String(args?.name ?? ''), exec)
              break
            case 'call':
              value = await callTool(String(args?.name ?? ''), args?.arguments, exec)
              break
            case 'inventory':
              value = JSON.stringify(compactInventory(await inventory(exec, args?.kind), args?.kind, clampNumber(args?.limit, 1, 10, 5)))
              break
            case 'history':
              value = JSON.stringify(await journal.snapshot({ agentId: identity(exec), limit: 20 }), null, 2)
              break
            case 'stats':
              { const { stats, storage } = await journal.snapshot({ agentId: identity(exec) }); value = JSON.stringify({ stats, storage }, null, 2) }
              break
            case 'report':
              value = buildReport(await journal.summary({ agentId: identity(exec) ?? undefined })).markdown
              break
            case 'status':
              value = await status(exec)
              break
            default:
              throw new Error('invalid_action: use search | load | describe | call | status | inventory | history | stats | report')
          }
          return typeof value === 'string' ? { content: [{ type: 'text', text: value }] } : value
        } catch (error) {
          const messageText = message(error)
          if (hasErrorCode(messageText)) throw error
          throw new Error(`execution_failed: ${messageText}`)
        }
      },
    }),
  )

  // The model cannot search for a name it has never seen. Keep the full catalog
  // out of the prompt, but publish the bounded name index so "I know something
  // exists" does not depend on a lexical guess; details still come from
  // search/describe/load.
  const promptText = (names = [], indexError = null) => {
    const messages = []
    if (config.promptHint) messages.push('Some third-party capabilities are gated behind the `capability` tool and are absent from the tool catalog. Search it before concluding that an external skill or MCP tool is unavailable.')
    if (indexError) messages.push(`Skill name index incomplete (${indexError}); skill availability is unknown. MCP names below remain scoped. Check capability inventory before relying on the skill index.`)
    if (!config.diagnostics.complete) messages.push(`Alias configuration has ${config.diagnostics.total} warning(s); search coverage is incomplete. Inspect capability inventory configDiagnostics.`)
    const hint = messages.join('\n')
    if (!config.promptIndex) return hint
    if (!names.length) return hint
    const shown = []
    let length = 0
    for (const name of names) {
      if (length + name.length + 2 > config.promptIndexChars) break
      shown.push(name)
      length += name.length + 2
    }
    const more = names.length > shown.length ? ` …+${names.length - shown.length} more` : ''
    return `${hint}\n\nManaged capabilities (hidden from the native catalog; open one with capability load <skill> or describe/call <mcp tool>):\n${shown.join(', ')}${more}`
  }
  if (config.promptHint || config.promptIndex) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'capability-gateway',
        order: 860,
        text: () => promptText(),
      }),
    )
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function compactInventory(catalog, kind, limit) {
  const complete = (kind === 'mcp' || (catalog.nativeSkillsComplete && catalog.skillRoots.every(x => x.state !== 'error')))
    && (kind === 'skill' || catalog.mcpConfigurationObserved)
    && (kind === 'mcp' || catalog.configDiagnostics.complete)
  const result = { scope: catalog.scope, kind: kind ?? 'all', complete, counts: {}, configDiagnostics: catalog.configDiagnostics }
  const anomalies = []
  const states = rows => rows.reduce((counts, row) => { counts[row.state] = (counts[row.state] ?? 0) + 1; return counts }, {})
  if (kind !== 'mcp') {
    result.nativeSkillsComplete = catalog.nativeSkillsComplete
    result.counts.skills = { total: catalog.skills.length, managed: catalog.skills.filter(x => x.managed).length, states: states(catalog.skills) }
    result.skillRoots = catalog.skillRoots
    if (!catalog.nativeSkillsComplete) anomalies.push({ kind: 'skill', state: 'discovery_incomplete' })
    for (const root of catalog.skillRoots) if (root.state === 'error') anomalies.push({ kind: 'skill', path: root.path, state: root.state, errorCode: root.errorCode })
    for (const skill of catalog.skills) if (['unknown', 'native_override', 'not_in_scope'].includes(skill.state)) anomalies.push({ kind: 'skill', name: skill.name, state: skill.state })
  }
  if (kind !== 'skill') {
    result.mcpConfigurationObserved = catalog.mcpConfigurationObserved
    const managed = catalog.mcp.filter(x => x.managed)
    result.counts.mcp = { servers: catalog.mcp.length, managedServers: managed.length,
      tools: catalog.mcp.reduce((sum, x) => sum + x.toolCount, 0), managedTools: managed.reduce((sum, x) => sum + x.toolCount, 0), states: states(catalog.mcp) }
    if (!catalog.mcpConfigurationObserved) anomalies.push({ kind: 'mcp', state: 'configuration_unobserved' })
    for (const server of catalog.mcp) {
      if (server.state !== 'tools_registered') anomalies.push({ kind: 'mcp', name: server.name, state: server.state })
      for (const entry of server.registrations) if (entry.conflict) anomalies.push({ kind: 'mcp', name: server.name, entryId: entry.entryId, state: 'registration_conflict' })
    }
  }
  result.anomalies = { total: anomalies.length, shown: Math.min(limit, anomalies.length), truncated: anomalies.length > limit, items: anomalies.slice(0, limit) }
  result.fullInventory = '设置 → 内置插件 → 能力网关 → 接入清单'
  return result
}

function normalizeConfig(raw) {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('invalid_config: configuration must be an object')
  const config = raw && typeof raw === 'object' ? raw : {}
  for (const key of ['skillRoots', 'mcpServers']) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some(value => typeof value !== 'string' || !value.trim() || (key === 'mcpServers' && !/^[A-Za-z0-9_-]{1,32}$/.test(value.trim()))))) {
      throw new Error(`invalid_config: ${key} must be an array of nonempty ${key === 'mcpServers' ? 'server names (letters, digits, _ or -, at most 32 characters)' : 'directory paths'}`)
    }
  }
  const skillRoots = Array.isArray(config.skillRoots)
    ? config.skillRoots.map((root) => expandHome(String(root))).filter(Boolean)
    : []
  const mcpServers = Array.isArray(config.mcpServers)
    ? config.mcpServers
        .map((server) => String(server).trim())
        .filter((server) => /^[A-Za-z0-9_-]{1,32}$/.test(server))
    : []
  const mcpKeywords = keywordMap(config.mcpKeywords, 'mcpKeywords', { pattern: /^[A-Za-z0-9_-]{1,32}$/, label: '服务名' })
  // Alias sources, lowest priority first: local pack, shared packs, inline config.
  // Tests disable the local pack so behaviour never depends on this machine.
  const keywordPacks = Array.isArray(config.keywordPacks) ? config.keywordPacks.map(pack => expandHome(String(pack))) : []
  if (config.keywordPacks !== undefined && (!Array.isArray(config.keywordPacks) || config.keywordPacks.some(pack => typeof pack !== 'string' || !pack.trim()))) {
    throw new Error('invalid_config: keywordPacks 必须是文件路径数组')
  }
  const diagnostics = []
  const packKeywords = readKeywordPacks(keywordPacks, diagnostics)
  const localSkillKeywords = config.localAliases === false ? {} : readKeywordPacks([new URL('./local/skill-keywords.json', import.meta.url)], diagnostics, 'localAliases')
  const inlineKeywords = keywordMap(config.skillKeywords, 'skillKeywords', { pattern: /^[A-Za-z0-9_.-]{1,80}$/, label: '技能名' })
  // Aliases are additive: a later source adds synonyms instead of replacing the
  // ones an earlier pack supplied for the same skill.
  const mergedSkillKeywords = new Map()
  for (const source of [localSkillKeywords, packKeywords, Object.fromEntries(inlineKeywords)]) {
    for (const [name, words] of Object.entries(source)) {
      mergedSkillKeywords.set(name, [...new Set([...(mergedSkillKeywords.get(name) ?? []), ...words])])
    }
  }
  const skillKeywords = mergedSkillKeywords
  if (config.enabled !== false && config.wrapSkills !== false
      && skillRoots.some((root) => root === expandHome('~/.dsh/skills'))) {
    throw new Error('invalid_config: ~/.dsh/skills is reserved for personal skills')
  }
  return {
    enabled: config.enabled !== false,
    wrapSkills: config.wrapSkills !== false,
    wrapMcp: config.wrapMcp !== false,
    skillRoots,
    mcpServers,
    mcpKeywords,
    skillKeywords,
    maxResults: clampNumber(config.maxResults, 1, 10, 5),
    promptHint: config.promptHint !== false,
    promptIndex: config.promptIndex !== false,
    promptIndexChars: clampNumber(config.promptIndexChars, 200, 6000, 2000),
    keywordPacks,
    diagnostics: { complete: diagnostics.length === 0, total: diagnostics.length, shown: Math.min(10, diagnostics.length), truncated: diagnostics.length > 10, items: diagnostics.slice(0, 10) },
    logDir: config.logDir ? expandHome(String(config.logDir)) : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'capability-gateway'),
  }
}

// Shared alias packs are plain JSON files (name -> keyword array). A missing or
// unreadable pack is skipped: aliases are optional data, never a startup error.
function readKeywordPacks(paths, diagnostics, source = 'keywordPacks') {
  const merged = Object.create(null)
  for (const [index, path] of paths.entries()) {
    const warn = code => diagnostics.push({ source, index: index + 1, code })
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if (source !== 'localAliases' || error.code !== 'ENOENT') warn(error.code === 'ENOENT' ? 'file_missing' : 'file_unreadable')
      continue
    }
    let value
    try { value = JSON.parse(raw) } catch { warn('invalid_json'); continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { warn('invalid_pack'); continue }
    let invalidEntries = 0
    const entries = []
    for (const [entryIndex, [name, words]] of Object.entries(value).entries()) {
      try {
        const valid = keywordMap({ [name]: words }, source, { pattern: /^[A-Za-z0-9_.-]{1,80}$/, label: '技能名' }).get(name)
        merged[name] = [...new Set([...(merged[name] ?? []), ...valid])]
      } catch { invalidEntries++; if (entries.length < 10) entries.push(entryIndex + 1) }
    }
    if (invalidEntries) { warn('invalid_entries'); Object.assign(diagnostics.at(-1), { count: invalidEntries, entries }) }
  }
  return merged
}

function keywordMap(value, label, { pattern, label: nameLabel }) {
  const map = new Map()
  if (value === undefined) return map
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_config: ${label} 必须是${nameLabel}到关键词数组的映射`)
  for (const [index, [name, keywords]] of Object.entries(value).entries()) {
    if (!pattern.test(name) || !Array.isArray(keywords) || keywords.length > 50
      || keywords.some(word => typeof word !== 'string' || !word.trim() || Array.from(word.trim()).length > 80)) {
      throw new Error(`invalid_config: ${label} 第 ${index + 1} 项的${nameLabel}无效，或关键词不是非空字符串数组（每项最多 80 字、每${nameLabel}最多 50 项）`)
    }
    map.set(name, [...new Set(keywords.map(word => word.trim()))])
  }
  return map
}

function expandHome(input) {
  if (!input) return ''
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2))
  return resolve(input)
}

function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  if (lines[0] !== '---') return { data: {}, body: source }
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      close = index
      break
    }
  }
  if (close === -1) return { data: {}, body: source }
  const data = parseYaml(lines.slice(1, close).join('\n'))
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, body: lines.slice(close + 1).join('\n') }
}

function bound(value, max = MAX_DESCRIPTION) {
  if (value === undefined || value === null) return undefined
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// A skill may declare aliases as a YAML list or a comma/space separated string.
// Values are bounded like any other indexed metadata; invalid items are dropped
// instead of failing the whole scan (a bad alias must not hide a working skill).
function normalizeKeywordList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，;；\n]+/) : []
  return [...new Set(list
    .map(word => (typeof word === 'string' ? word.trim() : ''))
    .filter(word => word && Array.from(word).length <= 40))]
    .slice(0, 20)
}

function boolish(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 1) return true
  if (value === 0) return false
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  return fallback
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function contentText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks
    .map((block) => {
      if (block?.type === 'text') return block.text ?? ''
      if (block?.type === 'image') return '[image returned; open the tool card to inspect it]'
      return `[${block?.type ?? 'unknown'} content]`
    })
    .filter(Boolean)
    .join('\n')
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

export { parseFrontmatter }
