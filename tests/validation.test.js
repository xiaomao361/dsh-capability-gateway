import test from 'node:test'
import assert from 'node:assert/strict'
import { createArgumentValidator } from '../validation.js'

test('schema validation supports nested references and composition without changing input', () => {
  const validate = createArgumentValidator()
  const schema = { type: 'object', definitions: { target: { type: 'string', minLength: 2 } },
    properties: { endpoint: { $ref: '#/definitions/target' }, ids: { type: 'array', items: { type: 'integer' } },
      mode: { oneOf: [{ const: 'read' }, { const: 'inspect' }] }, optional: { type: 'string', default: 'unchanged' } },
    required: ['endpoint', 'ids', 'mode'], additionalProperties: false }
  const args = { endpoint: 'local', ids: [1, 2], mode: 'read' }
  const before = structuredClone(args)
  validate('fixture', schema, args)
  assert.deepEqual(args, before)
  for (const bad of [{ ...args, ids: ['1'] }, { ...args, mode: 'write' }, { ...args, endpoint: '' }, { ...args, extra: true }]) {
    assert.throws(() => validate('fixture', schema, bad), /invalid_arguments:/)
  }
})

test('unsupported or unresolved schemas block dispatch explicitly; 2019 and 2020 drafts validate', () => {
  const validate = createArgumentValidator()
  for (const schema of [
    { $ref: 'https://never-fetch.invalid/schema' },
    { type: 'object', inventedConstraint: true },
    { $schema: 'https://never-fetch.invalid/draft', type: 'object' },
    { type: 'object', properties: { endpoint: { type: 'string', format: 'unknown-custom-format' } } },
  ]) assert.throws(() => validate('fixture', schema, {}), /unavailable:.*no call was dispatched/)
  for (const draft of ['2019-09', '2020-12']) {
    const schema = { $schema: `https://json-schema.org/draft/${draft}/schema`, type: 'object', properties: { endpoint: { type: 'string' } }, required: ['endpoint'] }
    assert.throws(() => validate('fixture', schema, {}), /invalid_arguments:/)
    validate('fixture', schema, { endpoint: 'fixture' })
  }
})
