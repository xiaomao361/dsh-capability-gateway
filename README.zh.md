# dsh-capability-gateway

[English](README.md) | 中文

DeepSeek Harness 的按需能力网关：把主动接管的第三方技能与 MCP 工具收进一个入口。

装得多了会出两件事：模型可见的工具目录越长，越挤占真正要做的任务；所有能力同等可见，模型也更容易选错。这个插件把你主动选定的那部分从原生目录里收起来，只保留一个 `capability` 工具——按意图搜索、读参数或说明、再调用。

它是 DSH 的 host + client 插件：不转发远端流量、不额外起服务、也不向外发送任何数据。

## 它改变了什么

- **被接管的技能**离开模型可见的技能目录，仍然可以由用户手动调用，通过 `capability` 加载。
- **被接管的 MCP 服务**保留原生执行路径，但工具 schema 从提示里移除；调用仍走原有的权限与 guard 链。
- **一个工具**（`capability`）替代原本几十条工具定义。
- **一段有界的名称索引**写进系统提示，让模型知道“有哪些能力”，即使词法搜索没命中。只有名字，不含描述和 schema。
- **本地日志**记录搜索与调用的元数据（不记录查询原文、参数、返回值），可导出为周报。

## 安装

```sh
# 在 DSH profile 目录下
pnpm add link:/path/to/dsh-capability-gateway   # 或：pnpm add dsh-capability-gateway
```

在 `~/.dsh/profiles/<profile>/package.json` 里注册 bundle：

```json
{
  "dependencies": { "dsh-capability-gateway": "link:/path/to/dsh-capability-gateway" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-capability-gateway"
  ] } }
}
```

再声明接管什么：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: capability-gateway
  config:
    skillRoots:
      - '~/.agents/skills'
    mcpServers:
      - my-mcp-server
```

包内默认什么都不接管：接管范围是安装数据，不是包数据。id 补丁会整体替换 `config`，所以需要的键要写全。

重载插件（或重启 DSH）。设置入口在 **设置 → 内置插件 → 能力网关**。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 让插件失效，并把所有能力恢复成原生暴露。 |
| `skillRoots` | `[]` | 交给网关的技能目录。 |
| `mcpServers` | `[]` | 接管的 MCP 服务名；其 `mcp__<server>__*` 工具被管理。 |
| `wrapSkills` / `wrapMcp` | `true` | 单独开关技能或 MCP 这一半。 |
| `mcpKeywords` | `{}` | `{ "服务": ["别名", ...] }`。 |
| `skillKeywords` | `{}` | `{ "技能": ["别名", ...] }`。 |
| `keywordPacks` | `[]` | 别名包 JSON 文件，按顺序叠加。 |
| `promptHint` | `true` | 加一句“能力在 `capability` 后面”的提示。 |
| `promptIndex` | `true` | 加有界的能力名索引。 |
| `promptIndexChars` | `2000` | 索引字符上限（200–6000）。 |
| `maxResults` | `5` | 搜索返回候选数（1–10）。 |
| `logDir` | `$DSH_HOME/data/capability-gateway` | 日志目录。 |

### 别名

中文提问很少与英文技能描述共享词元，词法搜索无法猜出没见过的词汇。别名就是补这个缺口的方式，而且始终是数据：

```yaml
skillKeywords:
  release-notes: [发布说明, 变更记录]
```

或者一个可分享的别名包，由 `keywordPacks` 引用：

```json
{ "release-notes": ["发布说明", "变更记录"] }
```

缺失或损坏的包会被跳过，不会阻塞启动。技能也可以在 `SKILL.md` 里用 `keywords:` 自带别名，随技能一起分发。

## `capability` 工具

| action | 用途 |
|---|---|
| `search` | 按目标、短关键词或名称找候选。 |
| `load` | 返回技能说明与基准目录。 |
| `describe` | 返回某个 MCP 工具的精确 JSON Schema。 |
| `call` | 调用 MCP 工具，调用前按该 schema 校验参数。 |
| `status` | 网关是否生效、接管了多少。 |
| `inventory` | 紧凑的计数、根目录、覆盖情况和有界异常。 |
| `history` / `stats` | 当前会话最近的路由元数据与窗口统计。 |
| `report` | 导出 Markdown 周报。 |

搜索刻意保守：没有匹配时返回 `not_found` 并指向原生方式，而不是编一个结果；网关也不会自己调用下游工具。

## 插件市场

DSH 的插件市场是“自带索引”的模式：`dsh-plugin-market` 只读取用户配置的索引 URL，默认一个都不配。本仓库自带一份格式 1 的索引：`market/index.json`。

启用 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 后，在插件页面的“发现”里添加：

```
https://raw.githubusercontent.com/xiaomao361/dsh-capability-gateway/main/market/index.json
```

索引只钉住具体版本与来源；安装仍由 plugin manager 自己校验与批准。不启用市场也可以直接用插件管理器按包名或 Git 地址安装。

## 隐私

每条事件记录：动作、目标名、路由、结果、错误码、耗时、候选名与排名、插件版本。不记录：查询原文、工具参数、返回值、错误正文、凭据、文件路径。

全部在本地，不上传。周报只在你主动导出时生成，且只含计数与名称。别名包和本地检索快照属于本机数据，不进发布包。

## 限制

- 搜索是词法的，不是语义的。跨语言检索依赖别名是否齐全。
- 检索质量由固定任务集衡量（`tests/retrieval.test.js`），不保证对所有说法都成立。
- 日志只覆盖最近 7 天 / 10,000 条事件，是样本，不是审计。
- 提示里的能力名有长度上限，能力特别多时索引会被截断。

## 开发

```sh
npm run check   # 语法
npm test        # 单元、组件、真实运行库启动与检索测试
npm pack --dry-run
```

设计与行为契约见 [docs/DESIGN.md](docs/DESIGN.md)。

## 许可

MIT
