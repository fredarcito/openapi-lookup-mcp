import {
  collectDirectReferences,
  listOperations,
  referenceName,
  resolvePointer,
} from "./render.js"

const SCHEMA_PREFIXES = ["#/components/schemas/", "#/definitions/"]

const escapePointerKey = key => key.replace(/~/g, "~0").replace(/\//g, "~1")

const isSchemaReference = reference =>
  SCHEMA_PREFIXES.some(prefix => reference.startsWith(prefix))

export const listSchemaReferences = spec => [
  ...Object.keys(spec.components?.schemas || {}).map(
    schemaName => `${SCHEMA_PREFIXES[0]}${escapePointerKey(schemaName)}`
  ),
  ...Object.keys(spec.definitions || {}).map(
    schemaName => `${SCHEMA_PREFIXES[1]}${escapePointerKey(schemaName)}`
  ),
]

const targetsBySpec = new WeakMap()

const targetsOf = (spec, reference) => {
  if (!targetsBySpec.has(spec)) targetsBySpec.set(spec, new Map())
  const targets = targetsBySpec.get(spec)
  if (!targets.has(reference)) {
    targets.set(reference, [
      ...collectDirectReferences(resolvePointer(spec, reference)),
    ])
  }
  return targets.get(reference)
}

const expandReferences = (spec, startReferences, shouldFollow) => {
  const reached = new Set()
  const pending = [...startReferences]
  while (pending.length) {
    const reference = pending.pop()
    if (reached.has(reference)) continue
    reached.add(reference)
    if (shouldFollow(reference)) {
      pending.push(...targetsOf(spec, reference))
    }
  }
  return reached
}

const buildUsage = spec =>
  listOperations(spec).map(entry => {
    const ownReferences = collectDirectReferences({
      operation: entry.operation,
      parameters: entry.pathItem.parameters,
    })
    return {
      entry,
      direct: expandReferences(
        spec,
        ownReferences,
        reference => !isSchemaReference(reference)
      ),
      ownReferences,
    }
  })

const usageBySpec = new WeakMap()

const usageOf = spec => {
  if (!usageBySpec.has(spec)) usageBySpec.set(spec, buildUsage(spec))
  return usageBySpec.get(spec)
}

export const listOperationsWithSchemaNames = spec =>
  usageOf(spec).map(({ entry, direct }) => ({
    entry,
    schemaNames: [...direct].filter(isSchemaReference).map(referenceName),
  }))

export const findSchemaUsers = (spec, reference) => {
  const usage = usageOf(spec)
  const direct = usage.filter(({ direct: references }) =>
    references.has(reference)
  )
  const indirect = usage.filter(
    candidate =>
      !direct.includes(candidate) &&
      expandReferences(spec, candidate.ownReferences, () => true).has(reference)
  )
  return {
    direct: direct.map(({ entry }) => entry),
    indirect: indirect.map(({ entry }) => entry),
  }
}

export const findSchemaReferences = (spec, requestedName) => {
  const wanted = requestedName.trim().split("/").pop().toLowerCase()
  const references = listSchemaReferences(spec)
  const exact = references.filter(
    reference => referenceName(reference) === requestedName.trim()
  )
  if (exact.length) return exact
  return references.filter(
    reference => referenceName(reference).toLowerCase() === wanted
  )
}

export const suggestSchemaReferences = (spec, requestedName) => {
  const wanted = requestedName.trim().split("/").pop().toLowerCase()
  return listSchemaReferences(spec).filter(reference => {
    const candidate = referenceName(reference).toLowerCase()
    return candidate.includes(wanted) || wanted.includes(candidate)
  })
}
