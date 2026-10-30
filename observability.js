import { appendFile, mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const ACTIONS = new Set(['search', 'load', 'describe', 'call', 'status', 'inventory', 'history', 'stats', 'report', 'invalid'])
const MAX_EVENTS = 10000
const WINDOW_MS = 7 * 86400000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const cleanName = value => typeof value === 'string' && /^[A-Za-z0-9_.:/@-]{1,220}$/.test(value) ? value : null
const cleanId = value => typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120) || null : null
const ERROR_CODES = new Set(['not_found', 'unavailable', 'dependency_missing', 'execution_failed', 'invalid_action', 'invalid_arguments', 'cancelled', 'native_error'])
// One classification for both the journal and the tool's error passthrough, so
// an allowlisted prefix is never re-wrapped as execution_failed by a second list.
export function hasErrorCode(message) {
  const code = String(message ?? '').match(/^([a-z_]+):/)?.[1]
  return code !== undefined && ERROR_CODES.has(code)
}
export function errorCode(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = message.match(/(?:^|Error:\s*)([a-z_]+):/)?.[1]
  return ERROR_CODES.has(code) ? code : 'native_error'
}

// Explicit field projection is the persistence boundary: no input/output/error
// prose, credentials, descriptions, or arbitrary objects can enter the journal.
const cleanVersion = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,20})?$/.test(value) ? value : null
export function projectEvent(input) {
  const row = {
    version: 1, id: cleanId(input.id) ?? randomUUID(),
    at: Number.isFinite(input.at) ? input.at : Date.now(),
    type: input.type === 'review' ? 'review' : 'operation',
  }
  if (row.type === 'review') return {
    ...row, eventId: cleanId(input.eventId), verdict: ['correct', 'wrong', 'unreviewed'].includes(input.verdict) ? input.verdict : 'unreviewed',
  }
  const target = cleanName(input.target)
  const actualTarget = cleanName(input.actualTarget)
  return {
    ...row, plugin: cleanVersion(input.plugin), action: ACTIONS.has(input.action) ? input.action : 'invalid',
    agentId: cleanId(input.agentId), callId: cleanId(input.callId),
    route: input.route === 'direct' ? 'direct' : 'gateway',
    kind: ['mcp', 'skill'].includes(input.kind) ? input.kind : null,
    target, actualTarget,
    outcome: ['success', 'error', 'cancelled'].includes(input.outcome) ? input.outcome : 'error',
    errorCode: ERROR_CODES.has(input.errorCode) ? input.errorCode : null,
    durationMs: Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : null,
    dispatched: input.dispatched === true,
    routeMatches: target && actualTarget ? target === actualTarget : null,
    candidates: (Array.isArray(input.candidates) ? input.candidates : []).slice(0, 10).flatMap(x => {
      const name = cleanName(x.name)
      return name && ['mcp', 'skill'].includes(x.kind) ? [{ name, kind: x.kind }] : []
    }),
    matchCount: Number.isSafeInteger(input.matchCount) && input.matchCount >= 0 ? input.matchCount : null,
    discoveryIncomplete: input.discoveryIncomplete === true,
    searchId: cleanId(input.searchId),
    candidateRank: Number.isSafeInteger(input.candidateRank) && input.candidateRank >= 0 ? input.candidateRank : null,
  }
}

// Shared by the settings snapshot, the model-facing history/stats actions, and
// the exported weekly report so all three report the same denominators.
export function computeStats(operations) {
  const routes = operations.filter(x => x.route === 'gateway' && ['call', 'load'].includes(x.action))
  const calls = operations.filter(x => x.route === 'gateway' && x.action === 'call')
  // Only a call that reached the upstream tool can say anything about MCP
  // reliability; argument validation and availability errors stop earlier.
  const dispatchedCalls = calls.filter(x => x.dispatched)
  const searches = operations.filter(x => x.route === 'gateway' && x.action === 'search')
  const correlated = routes.filter(x => x.searchId !== null && x.candidateRank !== null)
  const durations = calls.map(x => x.durationMs).filter(x => x !== null).sort((a, b) => a - b)
  return {
    operations: operations.length,
    calls: calls.length, callDispatched: dispatchedCalls.length, callRejected: calls.length - dispatchedCalls.length,
    callSuccesses: calls.filter(x => x.outcome === 'success').length,
    callErrors: calls.filter(x => x.outcome === 'error').length, callCancelled: calls.filter(x => x.outcome === 'cancelled').length,
    callSuccessRate: dispatchedCalls.length ? dispatchedCalls.filter(x => x.outcome === 'success').length / dispatchedCalls.length : null,
    searchCount: searches.length, searchIncomplete: searches.filter(x => x.discoveryIncomplete).length,
    searchMisses: searches.filter(x => !x.discoveryIncomplete && (x.errorCode === 'not_found' || x.matchCount === 0)).length,
    // A miss that still showed routing entries: the capability was not found,
    // only a way to keep looking was offered.
    searchFallbacks: searches.filter(x => !x.discoveryIncomplete && x.matchCount === 0 && x.candidates.length > 0).length,
    correlatedSelections: correlated.length, insideCandidates: correlated.filter(x => x.candidateRank > 0).length,
    candidateAdoptionRate: correlated.length ? correlated.filter(x => x.candidateRank > 0).length / correlated.length : null,
    explicitOrUnlinked: routes.filter(x => !x.searchId).length,
    routeMismatches: calls.filter(x => x.routeMatches === false).length,
    directCalls: operations.filter(x => x.route === 'direct').length,
    reviewedCorrect: routes.filter(x => x.verdict === 'correct').length,
    reviewedWrong: routes.filter(x => x.verdict === 'wrong').length,
    p95Ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
  }
}

const tally = (items, selector, limit = 5) => {
  const counts = new Map()
  for (const item of items) {
    const key = selector(item)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit).map(([name, count]) => ({ name, count }))
}

export class EventJournal {
  constructor(directory, { now = Date.now, pluginVersion = null } = {}) {
    this.directory = directory
    this.now = now
    this.pluginVersion = cleanVersion(pluginVersion)
    this.rows = []
    this.truncated = false
    this.invalidLines = 0
    this.readError = null
    this.writeError = null
    this.writeFailures = 0
    this.queue = Promise.resolve()
    this.ready = this.load()
  }
  trim() {
    const start = this.now() - WINDOW_MS
    this.rows = this.rows.filter(row => row.at >= start)
    if (this.rows.length > MAX_EVENTS) { this.rows = this.rows.slice(-MAX_EVENTS); this.truncated = true }
  }
  async load() {
    try {
      const days = (await readdir(this.directory)).filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort().slice(-8)
      for (const day of days) {
        const file = await open(join(this.directory, day), 'r')
        try {
          const { size } = await file.stat()
          const from = Math.max(0, size - MAX_FILE_BYTES)
          const buffer = Buffer.alloc(size - from)
          await file.read(buffer, 0, buffer.length, from)
          let text = buffer.toString('utf8')
          if (from) { text = text.slice(text.indexOf('\n') + 1); this.truncated = true }
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            try {
              const value = JSON.parse(line)
              if (value.version !== 1 || cleanId(value.id) !== value.id || !Number.isFinite(value.at)
                  || !Number.isFinite(new Date(value.at).getTime())
                  || !['operation', 'review'].includes(value.type)) throw new Error('invalid record')
              if (value.type === 'operation' && (!ACTIONS.has(value.action)
                  || !['success', 'error', 'cancelled'].includes(value.outcome)
                  || !['gateway', 'direct'].includes(value.route))) throw new Error('invalid operation')
              if (value.type === 'review' && (cleanId(value.eventId) !== value.eventId
                  || !['correct', 'wrong', 'unreviewed'].includes(value.verdict))) throw new Error('invalid review')
              this.rows.push(projectEvent(value))
            } catch { this.invalidLines++ }
          }
        } finally { await file.close() }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.readError = error.code ?? 'read_failed' }
    this.rows.sort((a, b) => a.at - b.at)
    this.trim()
  }
  record(input) {
    // Stamp the running plugin version so a later report can separate what was
    // observed before and after a rule change. Loaded rows keep their own value.
    const row = projectEvent({ plugin: this.pluginVersion, ...input })
    this.queue = this.queue.then(async () => {
      await this.ready
      this.rows.push(row)
      this.trim()
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        await appendFile(join(this.directory, `${new Date(row.at).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 })
        this.writeError = null
      } catch (error) { this.writeError = error.code ?? 'write_failed'; this.writeFailures++ }
    })
    return row.id
  }
  async snapshot({ agentId, limit = 100, offset = 0, anchorId, outcome, action } = {}) {
    await this.flush()
    this.trim()
    const selected = this.rows.filter(row => row.type === 'operation' && (!agentId || row.agentId === agentId))
    const reviews = new Map(this.rows.filter(x => x.type === 'review').map(x => [x.eventId, x.verdict]))
    const operations = selected.map(row => ({ ...row, verdict: reviews.get(row.id) ?? 'unreviewed' }))
    const stats = computeStats(operations)
    // Anchor the list to an observed event so incoming calls do not shift page boundaries.
    // Summary statistics intentionally continue to use the complete selected scope.
    const anchorIndex = anchorId === undefined ? operations.length - 1 : operations.findIndex(x => x.id === anchorId)
    if (anchorId !== undefined && anchorIndex < 0) throw new Error('not_found: history anchor expired; refresh records')
    const filtered = operations.slice(0, anchorIndex + 1).filter(x => (!outcome || x.outcome === outcome) && (!action || x.action === action)).reverse()
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 100))
    const pageOffset = Math.min(Math.max(0, Math.trunc(Number(offset) || 0)), Math.max(0, Math.ceil(filtered.length / pageLimit) - 1) * pageLimit)
    return {
      stats, events: filtered.slice(pageOffset, pageOffset + pageLimit), total: filtered.length,
      offset: pageOffset, limit: pageLimit, anchorId: operations[anchorIndex]?.id ?? null,
      storage: { directory: this.directory, windowDays: 7, maxEvents: MAX_EVENTS, truncated: this.truncated,
        invalidLines: this.invalidLines, readError: this.readError, writeError: this.writeError, writeFailures: this.writeFailures,
        complete: !this.truncated && !this.invalidLines && !this.readError && !this.writeError && this.writeFailures === 0 },
    }
  }
  // Aggregates for an exported weekly report: same rows, window and in-memory
  // limits as snapshot(), but without the per-event page. Nothing here reads
  // tool arguments, results, query text or the log directory path.
  async summary({ agentId } = {}) {
    await this.flush()
    this.trim()
    const reviews = new Map(this.rows.filter(x => x.type === 'review').map(x => [x.eventId, x.verdict]))
    const operations = this.rows.filter(row => row.type === 'operation' && (agentId === undefined || row.agentId === agentId)).map(row => ({ ...row, verdict: reviews.get(row.id) ?? 'unreviewed' }))
    const stats = computeStats(operations)
    const versions = new Map()
    for (const row of operations) {
      const version = row.plugin ?? 'unknown'
      if (!versions.has(version)) versions.set(version, [])
      versions.get(version).push(row)
    }
    return {
      generatedAt: this.now(),
      scope: { kind: agentId === undefined ? 'all' : 'agent', agentId: agentId ?? null },
      pluginVersion: this.pluginVersion,
      window: { days: 7, events: operations.length, from: operations[0]?.at ?? null, to: operations.at(-1)?.at ?? null, truncated: this.truncated },
      storage: { invalidLines: this.invalidLines, readError: this.readError, writeError: this.writeError, writeFailures: this.writeFailures,
        complete: !this.truncated && !this.invalidLines && !this.readError && !this.writeError && this.writeFailures === 0 },
      stats,
      derived: { missRate: stats.searchCount ? stats.searchMisses / stats.searchCount : null,
        fallbackRate: stats.searchCount ? stats.searchFallbacks / stats.searchCount : null },
      byVersion: [...versions].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([version, rows]) => ({ version, stats: computeStats(rows) })),
      errors: tally(operations.filter(x => x.errorCode), x => x.errorCode, 6),
      targets: tally(operations.filter(x => x.route === 'gateway' && x.action === 'call' && x.target), x => x.target),
      skills: tally(operations.filter(x => x.route === 'gateway' && x.action === 'load' && x.target), x => x.target),
    }
  }
  async review(eventId, verdict) {
    await this.flush()
    if (!['correct', 'wrong', 'unreviewed'].includes(verdict)) throw new Error('invalid_arguments: invalid verdict')
    if (!this.rows.some(x => x.id === eventId && x.type === 'operation' && x.route === 'gateway' && ['load', 'call'].includes(x.action))) {
      throw new Error('not_found: review requires an existing gateway load/call record')
    }
    this.record({ type: 'review', eventId, verdict, at: this.now() })
    await this.flush()
    if (this.writeError) throw new Error('unavailable: review was not persisted')
    return { eventId, verdict }
  }
  async flush() { await this.ready; await this.queue }
}
