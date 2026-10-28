# dsh-capability-gateway

English | [中文](README.zh.md)

One on-demand gateway for opted-in third-party skills and MCP tools in [DeepSeek Harness](https://deepseek.com).

Install enough MCP servers or skills and two things happen: the model's tool catalog grows until it crowds out the actual task, and the model starts choosing worse because every capability is equally visible. This plugin hides the ones you opt in and serves them through a single `capability` tool: search by intent, read the schema or instructions, then call.

It is a DeepSeek Harness host + client plugin. It does not proxy remote traffic, does not add a server, and does not send anything anywhere.

## What it changes

- **Managed skills** leave the model-facing skill catalog. They stay user-invocable and are loaded through `capability`.
- **Managed MCP servers** keep their native execution path but their tool schemas are removed from the prompt. Calls go through the same native permission and guard chain.
- **One tool** (`capability`) replaces what would otherwise be dozens of tool definitions.
- **A bounded name index** is added to the system prompt so the model knows *which* capabilities exist even when lexical search would miss them. Names only — no descriptions, no schemas.
- **A local journal** records metadata about searches and calls (never query text, arguments or results), and can be exported as a weekly report.

## Install

```sh
# from your DSH profile directory
pnpm add link:/path/to/dsh-capability-gateway   # or: pnpm add dsh-capability-gateway
```

Register the bundle in `~/.dsh/profiles/<profile>/package.json` so the plugin layer is applied:

```json
{
  "dependencies": { "dsh-capability-gateway": "link:/path/to/dsh-capability-gateway" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-capability-gateway"
  ] } }
}
```

Then declare what it manages:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: capability-gateway
  config:
    skillRoots:
      - '~/.agents/skills'
    mcpServers:
      - my-mcp-server
```

The package default manages nothing on purpose: what to wrap is install data, not package data. An `id` patch replaces the whole `config` object, so repeat every key you need.

Reload the plugin (or restart DSH). The settings page is at **Settings → Built-in plugins → Capability gateway**.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the plugin inert and restores native exposure. |
| `skillRoots` | `[]` | Directories whose skills are served by the gateway. |
| `mcpServers` | `[]` | MCP server names whose `mcp__<server>__*` tools are managed. |
| `wrapSkills` / `wrapMcp` | `true` | Turn either half on or off. |
| `mcpKeywords` | `{}` | `{ "server": ["alias", ...] }` for MCP entries. |
| `skillKeywords` | `{}` | `{ "skill": ["alias", ...] }`. |
| `keywordPacks` | `[]` | JSON files merged in order; aliases are additive. |
| `promptHint` | `true` | Add the "capabilities are behind `capability`" pointer. |
| `promptIndex` | `true` | Add the bounded capability name index. |
| `promptIndexChars` | `2000` | Cap for the index (200–6000). |
| `maxResults` | `5` | Search candidates returned (1–10). |
| `logDir` | `$DSH_HOME/data/capability-gateway` | Journal directory. |

### Aliases

A Chinese question rarely shares a token with an English skill description, and no lexical search can guess a vocabulary it has never seen. Aliases are how that gap gets closed, and they are always data:

```yaml
skillKeywords:
  release-notes: [发布说明, 变更记录]
```

or a shareable pack, referenced from `keywordPacks`:

```json
{ "release-notes": ["发布说明", "变更记录"] }
```

Missing or broken packs are skipped, never fatal. A skill can also declare its own aliases in `SKILL.md` with `keywords:`, which travels with the skill.

## The `capability` tool

| Action | Purpose |
|---|---|
| `search` | Find candidates by goal, short keywords or a name. |
| `load` | Return a skill's instructions and base directory. |
| `describe` | Return one MCP tool's exact JSON Schema. |
| `call` | Invoke an MCP tool; arguments are validated against that schema first. |
| `status` | Whether the gateway is active and how much it manages. |
| `inventory` | Compact counts, roots, coverage and bounded anomalies. |
| `history` / `stats` | This session's recent routing metadata and window statistics. |
| `report` | Export a weekly summary as Markdown. |

Search is deliberately conservative. Unmatched queries return `not_found` with a pointer to the native path rather than a fake match, and the gateway never calls an upstream tool on its own.

## Plugin market

DSH's plugin market is bring-your-own-index: `dsh-plugin-market` only reads index URLs a user configures, and none are configured by default. This repository ships a format-1 index at [market/index.json](market/index.json).

With `@deepseek-ai/dsh-experimental-plugin-market-bundle` enabled, add it under Plugins → Discover:

```
https://raw.githubusercontent.com/xiaomao361/dsh-capability-gateway/main/market/index.json
```

The index pins an exact version and its source; installing still goes through the plugin manager's own compatibility check and approval. The market is optional — installing by package name or Git URL works without it.

## Privacy

Recorded per event: action, target name, route, outcome, error code, duration, candidate names and ranks, plugin version. Not recorded: query text, tool arguments, results, error bodies, credentials, file paths.

Everything is local. Nothing is uploaded. A report is produced only when you export it, and it contains counts and names only. Alias packs and the local retrieval snapshot are per-install data and are not part of the published package.

## Limitations

- Search is lexical, not semantic. Cross-language retrieval depends on aliases being present.
- Retrieval quality is measured on a fixed task set (`tests/retrieval.test.js`); it is not a guarantee for every phrasing.
- The journal covers the last 7 days / 10,000 events and is a sample, not an audit.
- Capability names in the prompt are bounded; very large installs will show a truncated index.

## Development

```sh
npm run check   # syntax
npm test        # unit, component, client-boot and retrieval tests
npm pack --dry-run
```

Design notes and the behaviour contract live in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
