import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'

// Own-entry edits only. The host owns locking, persistence, rollback and reload.
// Never expose the raw config (it may contain unrelated private values).
export function createManagement(ctx, config, validate) {
  const editorOf = () => ctx.get('configEditor')
  const entryOf = editor => editor?.entries?.().find(entry => entry.fiber === ctx.fiber)
  const revisionOf = (entry, raw = entry.options.config ?? {}) => createHash('sha256').update(JSON.stringify([entry.fiber.uid, raw])).digest('hex')
  function snapshot(inventory) {
    const editor = editorOf()
    const entry = entryOf(editor)
    const roots = new Set(config.skillRoots)
    for (const skill of inventory.skills) {
      if (!['user-agents', 'custom'].includes(skill.source) || !skill.path) continue
      // Managed paths already have an authoritative root. Infer only native
      // filesystem roots; project, bundled and personal skills stay native.
      if (skill.managed) continue
      roots.add(basename(skill.path) === 'SKILL.md' ? dirname(dirname(skill.path)) : dirname(skill.path))
    }
    const writable = Boolean(entry && typeof editor.edit === 'function')
    return {
      writable,
      revision: entry ? revisionOf(entry) : null,
      reason: writable ? null : 'host_config_editor_unavailable',
      skillRoots: [...config.skillRoots], mcpServers: [...config.mcpServers],
      rootChoices: [...roots].sort(),
    }
  }
  async function save(options) {
    const editor = editorOf()
    const entry = entryOf(editor)
    if (!entry || typeof editor.edit !== 'function') throw new Error('unavailable: 宿主未提供此插件的配置保存接口，请通过宿主配置管理接管范围。')
    if (!options || typeof options.revision !== 'string' || !Array.isArray(options.skillRoots) || !Array.isArray(options.mcpServers)) throw new Error('invalid_arguments: revision、skillRoots 和 mcpServers 必填')
    // Validate before any mutation and again under the host's edit lock.
    validate({ skillRoots: options.skillRoots, mcpServers: options.mcpServers, localAliases: false })
    await editor.edit(entry, current => {
      if (revisionOf(entry, current) !== options.revision) throw new Error('conflict: 配置已变化，请刷新后重新选择。')
      if (!current || typeof current !== 'object' || Array.isArray(current) || Object.hasOwn(current, '__jsExpr')) throw new Error('unavailable: 表达式配置请通过宿主配置管理修改。')
      const normalized = validate({ ...current, skillRoots: options.skillRoots, mcpServers: options.mcpServers })
      return { ...current, skillRoots: [...new Set(normalized.skillRoots)], mcpServers: [...new Set(normalized.mcpServers)] }
    })
    return { saved: true, reload: 'host', message: '已保存并由宿主应用配置，请刷新确认接管结果。' }
  }
  return { snapshot, save }
}
