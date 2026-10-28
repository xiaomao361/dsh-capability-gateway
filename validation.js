import Ajv from 'ajv'
import Ajv2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

export function createArgumentValidator() {
  // Never coerce, insert defaults, remove arguments or fetch remote references.
  const options = { allErrors: true, strict: false, strictSchema: true, ownProperties: true, addUsedSchema: false, logger: false }
  const engines = [Ajv, Ajv2019, Ajv2020].map(Engine => addFormats(new Engine(options)))
  const cache = new Map()
  return (name, schema, args) => {
    let validate
    try {
      const key = JSON.stringify(schema)
      validate = cache.get(key)
      if (!validate) {
        const draft = schema?.$schema ?? ''
        const engine = engines[/2020-12/.test(draft) ? 2 : /2019-09/.test(draft) ? 1 : 0]
        validate = engine.compile(schema)
        if (validate.$async) throw new Error('async schema validation is unsupported')
        if (cache.size >= 32) cache.delete(cache.keys().next().value)
        cache.set(key, validate)
      }
    } catch {
      throw new Error(`unavailable: cannot validate the current schema for ${name}; no call was dispatched. Use action=describe to inspect the schema.`)
    }
    if (!args || typeof args !== 'object' || Array.isArray(args) || !validate(args)) {
      const errors = !args || typeof args !== 'object' || Array.isArray(args)
        ? ['arguments must be a JSON object']
        : validate.errors.slice(0, 5).map(error => `${error.instancePath || '/'}: ${error.message}`)
      throw new Error(`invalid_arguments: ${name}: ${errors.join('; ')}. No call was dispatched.\nParameters (JSON Schema):\n${JSON.stringify(schema)}`)
    }
  }
}
