# Changelog

## 0.4.0

- Add a bounded capability name index to the system prompt (`promptIndex`, `promptIndexChars`) so the model knows which managed capabilities exist without lexical search.
- Add shareable alias packs (`keywordPacks`); aliases from packs, the local pack and inline config are merged instead of replacing each other.
- Split the retrieval test suite: a generic synthetic catalog runs in CI, a real install snapshot is evaluated from `local/` when present.
- Package defaults no longer name any install-specific skill root or MCP server; the profile patch supplies them.

## 0.3.2

- Move install scope out of the package patch; `cordis.patch.yml` now ships empty `skillRoots` and `mcpServers`.
- Add distribution guards: shipped code must not name a vendor, server or private skill, and the package must not carry per-install data.

## 0.3.1

- Rework search: generic task words are no longer signal, an unknown word no longer vetoes the query, coverage is measured over indexed terms, Chinese text gets 2–4 character n-gram expansion, and plurals fall back to their stem.
- Add skill aliases via `SKILL.md` `keywords:`, `skillKeywords` config and a local alias pack.
- Retrieval quality is now measured by a fixed task set instead of ad-hoc checks.

## 0.3.0

- Stamp every journaled event with the running plugin version.
- Add `capability action=report` and “Export report / JSON” in the settings page: a weekly summary built from allowlisted metadata only.

## 0.2.9

- Call success rate now uses dispatched calls as the denominator; argument validation and availability errors no longer count as MCP failures.
- A search that returned no candidates no longer links later calls into the adoption metric.
- A query without a query string lists names instead of reporting a match.

## 0.2.8

- Paginated inventory and call records, with real Host-side pagination and stable anchors.
- Restructured both settings views: overview counts, primary/secondary metrics, per-service tool pagination, theme-aware styling.

## 0.2.7

- Reject unknown identifiers instead of letting a generic word hide them; add coverage and anchor checks.

## 0.2.6

- Limit the speculative routing fallback to short keyword queries.

## 0.2.5

- Add a routing-entry fallback for aggregated MCP servers whose downstream catalog is not visible.

## 0.2.4

- Bounded candidate summaries, word-boundary ranking, pre-dispatch schema validation, compact inventory, type filters.

## 0.2.3

- Replace the inventory table with compact expandable lists.

## 0.2.2

- Reorganise both settings views; separate metrics from the record list.

## 0.2.1

- Use strict Remote codecs for snapshot/review; fixes a web boot failure.

## 0.2.0

- Initial settings page: capability inventory and routing observations.
