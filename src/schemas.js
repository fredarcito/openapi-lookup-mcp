import { EXTERNAL_DOCUMENTS_KEY } from "./bundle.js"
import {
  collectDirectReferences,
  listOperations,
  referenceName,
  resolvePointer,
} from "./render.js"

const SCHEMA_SECTIONS = ["/components/schemas/", "/definitions/"]
const EXTERNAL_PREFIX = `#/${EXTERNAL_DOCUMENTS_KEY}/`
const OTHER_SECTION_PATTERN =
  /^\/(components\/(?!schemas\/)[^/]+|parameters|responses|paths|securityDefinitions)\//

const escapePointerKey = key => key.replace(/~/g, "~0").replace(/\//g, "~1")

// Splits a reference into the document it lives in ("#" for the spec
// itself) and the pointer inside that document.
const splitDocument = reference => {
  if (!reference.startsWith(EXTERNAL_PREFIX)) {
    return { documentPrefix: "#", pointer: reference.slice(1) }
  }
  const keyEnd = reference.indexOf("/", EXTERNAL_PREFIX.length)
  return keyEnd === -1
    ? { documentPrefix: reference, pointer: "" }
    : {
        documentPrefix: reference.slice(0, keyEnd),
        pointer: reference.slice(keyEnd),
      }
}

// In the spec itself only the schema sections hold schemas. Other files
// are free-form, so anything outside a known non-schema section counts.
const isSchemaReference = reference => {
  const { documentPrefix, pointer } = splitDocument(reference)
  return documentPrefix === "#"
    ? SCHEMA_SECTIONS.some(section => pointer.startsWith(section))
    : !OTHER_SECTION_PATTERN.test(pointer)
}

const declaredSchemaReferences = (document, documentPrefix) => [
  ...Object.keys(document?.components?.schemas || {}).map(
    schemaName =>
      `${documentPrefix}${SCHEMA_SECTIONS[0]}${escapePointerKey(schemaName)}`
  ),
  ...Object.keys(document?.definitions || {}).map(
    schemaName =>
      `${documentPrefix}${SCHEMA_SECTIONS[1]}${escapePointerKey(schemaName)}`
  ),
]

const buildSchemaReferences = spec => {
  const externalDocuments = Object.entries(spec[EXTERNAL_DOCUMENTS_KEY] || {})
  if (!externalDocuments.length) return declaredSchemaReferences(spec, "#")
  const referencedExternally = [...collectDirectReferences(spec)].filter(
    reference =>
      reference.startsWith(EXTERNAL_PREFIX) && isSchemaReference(reference)
  )
  return [
    ...new Set([
      ...declaredSchemaReferences(spec, "#"),
      ...externalDocuments.flatMap(([location, document]) =>
        declaredSchemaReferences(
          document,
          `${EXTERNAL_PREFIX}${escapePointerKey(location)}`
        )
      ),
      ...referencedExternally,
    ]),
  ]
}

const schemaReferencesBySpec = new WeakMap()

export const listSchemaReferences = spec => {
  if (!schemaReferencesBySpec.has(spec)) {
    schemaReferencesBySpec.set(spec, buildSchemaReferences(spec))
  }
  return schemaReferencesBySpec.get(spec)
}

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

// For every operation: the schemas it references itself and the schemas
// those reference in turn (one level further, not the whole graph).
export const listOperationsWithSchemaNames = spec =>
  usageOf(spec).map(({ entry, direct }) => {
    const schemaReferences = [...direct].filter(isSchemaReference)
    const nestedReferences = new Set(
      schemaReferences.flatMap(reference => targetsOf(spec, reference))
    )
    return {
      entry,
      schemaNames: schemaReferences.map(referenceName),
      nestedSchemaNames: [...nestedReferences]
        .filter(
          reference => isSchemaReference(reference) && !direct.has(reference)
        )
        .map(referenceName),
    }
  })

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
