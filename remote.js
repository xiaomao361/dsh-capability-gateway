import { z } from 'zod'
const PACKAGE = 'dsh-capability-gateway'
// Client and Host both require strict JSON input/result codecs. Kept in sync
// with the standalone browser factory by schema-contract and activation tests.
const snapshotOptions = () => z.strictObject({
  agentId: z.string().optional(), historyScope: z.enum(['all', 'selected']).optional(),
  outcome: z.enum(['success', 'error', 'cancelled']).optional(),
  action: z.enum(['search', 'load', 'describe', 'call']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).max(10000).optional(),
  anchorId: z.string().min(1).max(200).optional(),
})
const reviewOptions = () => z.strictObject({ eventId: z.string().min(1), verdict: z.enum(['correct', 'wrong', 'unreviewed']) })
// Reports accept only the displayed session scope and format, never user text.
const reportOptions = () => z.strictObject({ format: z.enum(['markdown', 'json']).optional(),
  historyScope: z.enum(['all', 'selected']).optional(), agentId: z.string().min(1).max(200).optional() })
const options = { snapshot: snapshotOptions, review: reviewOptions, report: reportOptions }
export const descriptors = Object.keys(options).map(method => {
  const codec = { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Options`, create: options[method] }
  return {
    id: `${PACKAGE}#capabilityGateway/${method}`, namespace: 'capabilityGateway',
    service: 'capabilityGateway', method, invocation: { kind: 'direct' },
    parameters: [{ name: 'options', wire: 'options', source: 'json', acceptsUndefined: method !== 'review', codec, strictCodec: codec }],
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, create: () => z.json() },
  }
})
export function registerRemote(ctx, service) {
  Object.defineProperty(service, 'typertRemote', { value: Object.freeze({
    service, serviceKey: 'capabilityGateway', namespace: 'capabilityGateway',
  }) })
  ctx.provide('capabilityGateway', service)
  ctx.inject(['typert'], remoteCtx => {
    remoteCtx.typert.register({ package: PACKAGE, face: 'host', schemas: [], model: {}, invocations: descriptors })
  })
}
