// Ranking uses full discovery metadata; only the returned preview is shortened.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
// Task-generic words carry no capability signal: an unknown word plus "logs"
// must not look like a capability match, and "当前" must not anchor a query.
// Domain words (build, test, deploy, error, 错误, 日志) stay searchable.
const stopWords = new Set((
  'a an the to for of in on and or with please help me use using find get can how i want ' +
  'log logs error errors data tool tools service services file files page code check search ' +
  'list make run result results info support document documents task tasks problem problems issue issues ' +
  '我 我们 请 帮 帮我 使用 一下 这个 这份 一个 多个 的 和 或 并 ' +
  '当前 现在 目前 今天 明天 最近 之前 之后 时候 正在 然后 还是 就是 可能 应该 需要 想要 希望 ' +
  '这里 那里 这些 那些 什么 怎么 如何'
).split(' '))
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase()
// Function words only: the speculative routing fallback keeps counting generic
// task words, otherwise "unknown service keyword" would pass as a two-term query.
const functionWords = new Set('a an the to for of in on and or with please help me use using find get can how i want 我 我们 请 帮 帮我 使用 一下 这个 这份 一个 多个 的 和 或 并'.split(' '))

// Conservative singularisation: reboots/errors/logs must reach reboot/error/log,
// while short technical words (ve, ecs, sdk) and names are left untouched.
const stem = term => {
  if (/[^a-z]/.test(term) || term.length < 4) return term
  if (term.length > 5 && term.endsWith('ing')) return term.slice(0, -3)
  if (term.length > 4 && term.endsWith('ed')) return term.slice(0, -2)
  if (term.length > 4 && term.endsWith('es')) return term.slice(0, -2)
  if (term.length > 3 && term.endsWith('s')) return term.slice(0, -1)
  return term
}

function words(value) {
  const text = normalize(value)
  const latin = text.match(/[a-z0-9]+/g) ?? []
  const chinese = [...segmenter.segment(text)].filter(x => x.isWordLike && /\p{Script=Han}/u.test(x.segment)).map(x => x.segment)
  // ICU may split 余额 into two single characters. Keep such a run as a phrase
  // only when segmentation produced no word of its own; otherwise the phrase
  // duplicates real tokens and inflates the coverage denominator.
  const runs = text.match(/\p{Script=Han}+/gu) ?? []
  const phrases = runs.filter(run => run.length >= 2 && run.length <= 6
    && [...segmenter.segment(run)].filter(x => x.isWordLike).every(x => x.segment.length === 1))
  // Tokens and phrases are additive: a phrase that nothing matches simply drops
  // out of the denominator instead of erasing the shorter, searchable tokens.
  return new Set([...latin, ...chinese, ...phrases].filter(x => x.length > 1 && !stopWords.has(x)))
}

function matches(term, tokens, text) {
  if (tokens.has(term)) return 1
  if (/\p{Script=Han}/u.test(term)) return text.includes(term) ? 0.8 : 0
  const base = stem(term)
  if (base !== term && tokens.has(base)) return 0.9
  for (const word of tokens) if (stem(word) === term) return 0.9
  // Short commands such as ve, rg and ls must be whole words.
  return term.length >= 3 && [...tokens].some(word => word.startsWith(term)) ? 0.5 : 0
}

export function allowsRoutingFallback(query) {
  const text = normalize(query).trim()
  if (!text || Array.from(text).length > 24) return false
  // Keep single-character content words here: dropping 拆 would incorrectly
  // turn the task "Excel 拆 sheet" into a two-keyword service lookup.
  const terms = [...segmenter.segment(text)].filter(x => x.isWordLike && !functionWords.has(x.segment))
  return terms.length >= 1 && terms.length <= 2
}

export function rankCapabilities(candidates, query) {
  const text = normalize(query).trim()
  if (!text) return candidates.map(item => ({ ...item, score: 1 })).sort((a, b) => a.name.localeCompare(b.name))
  const exact = candidates.filter(item => normalize(item.name) === text)
  if (exact.length) return exact.map(item => ({ ...item, keywordMatch: false, score: 1000 }))
  const mixedQuery = /\p{Script=Han}/u.test(text)
  const documents = candidates.map(item => {
    const name = normalize(item.name)
    const detail = normalize(`${item.detail ?? ''} ${item.whenToUse ?? ''}`)
    const keywords = normalize((item.keywords ?? []).join(' '))
    return { item, name, detail, keywords, nameWords: words(name), detailWords: words(detail), keywordWords: words(keywords) }
  })
  // ICU splits 看门狗复位 into single characters, so the run alone is not
  // searchable. Add the 2–4 character n-grams this catalog actually contains;
  // grams nobody carries never reach the coverage denominator.
  const grams = []
  for (const run of text.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let size = 2; size <= Math.min(4, run.length); size++) {
      for (let start = 0; start + size <= run.length; start++) {
        const gram = run.slice(start, start + size)
        if (stopWords.has(gram)) continue
        if (documents.some(doc => doc.name.includes(gram) || doc.detail.includes(gram) || doc.keywords.includes(gram))) grams.push(gram)
      }
    }
  }
  const terms = [...new Set([...words(text), ...grams])]
  if (!terms.length) return []
  const hits = (doc, term) => matches(term, doc.nameWords, doc.name) || matches(term, doc.detailWords, doc.detail) || matches(term, doc.keywordWords, doc.keywords)
  const frequencies = new Map(terms.map(term => [term, documents.filter(doc => hits(doc, term)).length]))
  // An unknown word no longer vetoes the whole query: "spacing grid layout looks
  // off" must still reach the right skill. Coverage is therefore measured over
  // the terms this catalog actually knows; unknown words only dilute the score.
  // "grafana logs" still fails because generic words are removed earlier, which
  // leaves {grafana} with zero known terms.
  const knownTerms = terms.filter(term => frequencies.get(term) > 0)
  if (!knownTerms.length) return []
  // Two known terms for a multi-term query: one incidental word (核对 in a
  // spreadsheet request) must not decide which capability is suggested. A query
  // with a single known term is carried by that term alone.
  const required = Math.min(2, knownTerms.length)
  // A term that appears in a capability name is a strong hint, but excluding
  // every other candidate on a shared English noun ("device") hid correct
  // skills. It stays as a ranking bonus through the name-hit weight instead.
  const knownLatin = knownTerms.filter(term => /^[a-z0-9]+$/.test(term))
  const weights = new Map(knownTerms.map(term => {
    const frequency = frequencies.get(term)
    // In mixed technical queries, explicit command/product identifiers are
    // stronger anchors than generic words such as 实例 or 列表.
    const anchor = mixedQuery && /^[a-z0-9]+$/.test(term) ? 2 : 1
    return [term, anchor * (1 + Math.log(1 + documents.length / (frequency + 1)))]
  }))
  const ranked = []
  for (const doc of documents) {
    let score = 0
    let keywordMatch = false
    let anchorHit = !knownLatin.length
    const matched = []
    for (const term of knownTerms) {
      const nameHit = matches(term, doc.nameWords, doc.name)
      const detailHit = matches(term, doc.detailWords, doc.detail)
      const keywordHit = matches(term, doc.keywordWords, doc.keywords)
      if (!nameHit && !detailHit && !keywordHit) continue
      if (keywordHit) { keywordMatch = true; anchorHit = true }
      if (/^[a-z0-9]+$/.test(term)) anchorHit = true
      matched.push(term)
      score += weights.get(term) * (nameHit * 8 + detailHit * 2 + keywordHit * 12)
    }
    // Overlapping n-grams ("并核对", "并核", "核对") describe one hit, not three.
    const han = matched.filter(term => /\p{Script=Han}/u.test(term))
    const coverage = matched.filter(term => !han.some(other => other !== term && other.includes(term))).length
    if (doc.name === text) score += 1000
    // An explicit alias hit anchors the candidate even when the rest of a long
    // query is unindexed (DESIGN §11).
    if (score && anchorHit && (coverage >= required || keywordMatch)) {
      ranked.push({ ...doc.item, keywordMatch, score: score * (1 + coverage / knownTerms.length) })
    }
  }
  return ranked.sort((a, b) => b.score - a.score || (a.routingPriority ?? 99) - (b.routingPriority ?? 99) || a.name.localeCompare(b.name))
}

// Discovery verbs only: never infer routing from a server name or recommend
// call/delete/update endpoint executors as a way to discover unknown services.
export function routingEntries(candidates) {
  return candidates.flatMap(item => {
    if (item.kind !== 'mcp') return []
    const prefix = `mcp__${item.server}__`
    const localName = item.name.startsWith(prefix) ? item.name.slice(prefix.length) : item.name
    const tokens = localName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
    if (tokens.some(token => ['call', 'execute', 'create', 'update', 'delete', 'remove', 'write', 'patch', 'set'].includes(token))) return []
    const routingPriority = ['search', 'find', 'discover', 'list'].findIndex(verb => tokens.includes(verb))
    return routingPriority < 0 ? [] : [{ ...item, routingPriority }]
  }).sort((a, b) => a.routingPriority - b.routingPriority || a.name.localeCompare(b.name))
}

export function preview(value) {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim())
  return chars.length > 120 ? `${chars.slice(0, 119).join('')}…` : chars.join('')
}
