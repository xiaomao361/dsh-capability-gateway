// Weekly report renderer. Input comes from EventJournal#summary(), which only
// holds allowlisted metadata: no query text, tool arguments, results, error
// prose, credentials or filesystem paths reach this module.
const SCHEMA = 'capability-gateway/report@1'
const pad = value => String(value).padStart(2, '0')
// Deterministic UTC+8 rendering so an exported report reads the same everywhere.
export const beijing = at => {
  if (!Number.isFinite(at)) return '—'
  const d = new Date(at + 8 * 3600_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC+8)`
}
const pct = value => value === null || value === undefined || Number.isNaN(value) ? '—' : `${(value * 100).toFixed(1)}%`
const ratio = (value, total) => total ? `${value} / ${total}（${pct(value / total)}）` : `${value} / ${total}`
const row = cells => `| ${cells.join(' | ')} |`
const list = items => items.length ? items.map(x => `- \`${x.name}\` · ${x.count}`).join('\n') : '- 无'

export function reportFilename(summary, format) {
  const day = Number.isFinite(summary?.generatedAt) ? beijing(summary.generatedAt).slice(0, 10) : 'unknown'
  return `capability-gateway-report-${day}.${format === 'json' ? 'json' : 'md'}`
}

export function buildReport(summary) {
  const { stats, window: scope, storage, derived } = summary
  const notes = []
  if (derived.missRate !== null) notes.push(`- 未命中率 ${pct(derived.missRate)}；兜底率 ${pct(derived.fallbackRate)}。`)
  if (scope.events < 20) notes.push('- 样本少于 20 条，只作单次观察，不构成趋势。')
  if (stats.searchCount === 0) notes.push('- 窗口内没有搜索样本，无法评估词表覆盖。')
  if (stats.calls > 0 && stats.callRejected === stats.calls) notes.push('- 全部调用都在网关侧被拒绝，未到达上游；检查参数或工具注册。')
  if (stats.correlatedSelections > 0 && stats.insideCandidates === 0) notes.push('- 候选关联样本全部落在候选之外；若来自 0.3.0 之前的事件，可能是旧关联口径（见 DESIGN 第 14 节）。')
  const lines = [
    '# 能力网关周报',
    '',
    `- 生成时间：${beijing(summary.generatedAt)}`,
    `- 运行插件版本：${summary.pluginVersion ?? '未知'}`,
    `- 统计窗口：最近 ${scope.days} 天，${scope.events} 条操作样本`,
    `- 样本时间：${beijing(scope.from)} → ${beijing(scope.to)}`,
    '',
    '## 总览',
    '',
    row(['指标', '数值']),
    row(['---', '---']),
    row(['操作数', stats.operations]),
    row(['网关 MCP 调用', `${stats.calls}（实际转发 ${stats.callDispatched}，未转发 ${stats.callRejected}）`]),
    row(['调用成功率', pct(stats.callSuccessRate)]),
    row(['搜索次数', stats.searchCount]),
    row(['搜索未命中', ratio(stats.searchMisses, stats.searchCount)]),
    row(['兜底入口', ratio(stats.searchFallbacks, stats.searchCount)]),
    row(['候选内采用率', pct(stats.candidateAdoptionRate)]),
    row(['候选关联样本', `${stats.correlatedSelections}（候选内 ${stats.insideCandidates}，未关联 ${stats.explicitOrUnlinked}）`]),
    row(['转发目标不一致', stats.routeMismatches]),
    row(['原生直接调用', stats.directCalls]),
    row(['人工标记', `正确 ${stats.reviewedCorrect} / 需修正 ${stats.reviewedWrong}`]),
    row(['p95 耗时', stats.p95Ms === null ? '—' : `${stats.p95Ms} ms`]),
    '',
    '## 变化线索',
    '',
    ...(notes.length ? notes : ['- 无可用观察。']),
    '',
    '## 按插件版本',
    '',
    row(['版本', '操作', '调用/转发', '成功率', '未命中', '兜底']),
    row(['---', '---', '---', '---', '---', '---']),
    ...summary.byVersion.map(x => row([x.version === 'unknown' ? '未记录（0.3.0 之前）' : x.version, x.stats.operations, `${x.stats.calls}/${x.stats.callDispatched}`, pct(x.stats.callSuccessRate),
      ratio(x.stats.searchMisses, x.stats.searchCount), ratio(x.stats.searchFallbacks, x.stats.searchCount)])),
    '',
    '## 错误码',
    '',
    list(summary.errors),
    '',
    '## 调用目标',
    '',
    list(summary.targets),
    '',
    '## 加载的技能',
    '',
    list(summary.skills),
    '',
    '## 样本完整性',
    '',
    `- 完整：${storage.complete ? '是' : '否'}；损坏行 ${storage.invalidLines}；写入失败 ${storage.writeFailures}；读取 ${storage.readError ?? '正常'}；写入 ${storage.writeError ?? '正常'}；窗口截断 ${scope.truncated ? '是' : '否'}。`,
    '',
    '## 说明',
    '',
    '- 只包含计数、状态、名称与耗时；不含查询原文、工具参数、结果正文、凭据或日志路径。',
    '- 调用成功率只统计实际转发到工具的调用；参数校验和可用性拒绝不计入分母。',
    '- 候选内采用率只观察返回过候选的搜索，不判断语义正确性。',
    '- 这是单机观察样本，不是完整审计，也不能证明能力选择正确。',
  ]
  return {
    markdown: lines.join('\n'),
    json: JSON.stringify({ schema: SCHEMA, ...summary }, null, 2),
  }
}
