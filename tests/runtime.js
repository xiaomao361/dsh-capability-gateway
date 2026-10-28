import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Test against the installed host, never a guessed mock of Cordis lifecycle.
export async function loadRuntime() {
  let modules = process.env.DSH_RUNTIME_NODE_MODULES
  let extracted
  if (!modules) {
    const archive = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
    const bytes = await readFile(archive)
    const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString())
    const dataOffset = 8 + bytes.readUInt32LE(4)
    extracted = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-'))
    modules = join(extracted, 'node_modules')
    async function copy(node, path) {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const target = join(path, name)
        if (entry.files) { await mkdir(target, { recursive: true }); await copy(entry, target) }
        else if (entry.offset !== undefined && !entry.unpacked) {
          const start = dataOffset + Number(entry.offset)
          await writeFile(target, bytes.subarray(start, start + entry.size))
        }
      }
    }
    await mkdir(modules)
    await copy(header.files.dsh.files.node_modules, modules)
  }
  async function load(name) {
    return import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href)
  }
  return {
    extracted,
    ...(await load('cordis')),
    SystemPrompt: (await load('dsh-system-prompt')).default,
    ToolRuntime: (await load('dsh-tools')).default,
    SkillRegistry: (await load('dsh-skill')).default,
    filesystem: await load('dsh-skill-filesystem'),
    createScope: (await load('dsh-scope')).createScope,
    TypertRegistry: (await load('dsh-typert-registry')).default,
    TypertGateway: (await load('dsh-api-gateway')).default,
    Peer: (await load('dsh-client-connection')).Peer,
  }
}

// Desktop's Client Remote runtime is packaged in the archive root, separately
// from the Host packages. Loading only dsh/node_modules cannot test web boot.
export async function loadBrowserRuntime() {
  const archive = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
  const bytes = await readFile(archive)
  const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString())
  const offset = 8 + bytes.readUInt32LE(4)
  const extracted = await mkdtemp(join(tmpdir(), 'dsh-gateway-client-runtime-'))
  const modules = join(extracted, 'node_modules')
  async function copy(node, path) {
    await mkdir(path, { recursive: true })
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const target = join(path, name)
      if (entry.files) await copy(entry, target)
      else if (entry.offset !== undefined && !entry.unpacked) {
        const start = offset + Number(entry.offset)
        await writeFile(target, bytes.subarray(start, start + entry.size))
      }
    }
  }
  await copy(header.files.node_modules, modules)
  const cordis = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')).href)
  const ClientRemote = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-api-gateway/lib/client.node.js')).href)
  return { extracted, ...cordis, ClientRemote }
}
