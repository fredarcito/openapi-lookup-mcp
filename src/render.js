import { stringify } from "yaml"

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]

const JSON_MEDIA_TYPE = "application/json"
const UNION_SEPARATOR = " | "
const COMPACT_SCHEMA_BUDGET = 16000
const RAW_SCHEMA_BUDGET = 32000
const MAX_OMITTED_NAMES = 40

const collapseWhitespace = text => String(text).replace(/\s+/g, " ").trim()

const decodePointerKey = key => key.replace(/~1/g, "/").replace(/~0/g, "~")

export const resolvePointer = (spec, reference) => {
  if (!reference.startsWith("#/")) return undefined
  return reference
    .slice(2)
    .split("/")
    .map(decodePointerKey)
    .reduce((node, key) => node?.[key], spec)
}

const dereference = (spec, node) =>
  node?.$ref ? resolvePointer(spec, node.$ref) : node

export const referenceName = reference => {
  const lastKey = decodePointerKey(reference.split("/").pop())
  return lastKey.includes("/")
    ? lastKey.split("/").pop().replace(/\.(ya?ml|json)$/i, "")
    : lastKey
}

const describeUnresolved = reference =>
  `unresolved reference ${reference} (not part of this spec)`

export const getPathItem = (spec, specPath) => {
  const node = spec.paths[specPath] || {}
  if (!node.$ref) return node
  const target = resolvePointer(spec, node.$ref)
  if (!target) return node
  const { $ref, ...siblings } = node
  return { ...target, ...siblings }
}

export const listOperations = spec =>
  Object.keys(spec.paths).flatMap(specPath => {
    const pathItem = getPathItem(spec, specPath)
    return HTTP_METHODS.filter(method => pathItem[method]).map(method => ({
      specPath,
      method,
      operation: pathItem[method],
      pathItem,
    }))
  })

export const renderOperationLine = ({ specPath, method, operation }) => {
  const summary = operation.summary
    ? ` — ${collapseWhitespace(operation.summary)}`
    : ""
  return `${method.toUpperCase()} ${specPath}${summary}`
}

const NOTE_KEYWORDS = [
  "readOnly",
  "writeOnly",
  "deprecated",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]

const renderKeywordNote = (schema, keyword) => {
  const value = schema[keyword]
  if (value === undefined || value === false) return []
  return [value === true ? keyword : `${keyword}: ${value}`]
}

const renderDiscriminatorNote = discriminator => {
  if (!discriminator) return []
  const propertyName = discriminator.propertyName || discriminator
  const mapping = Object.entries(discriminator.mapping || {})
    .map(([value, reference]) => `${value} → ${referenceName(reference)}`)
    .join(", ")
  return [`discriminator: ${propertyName}${mapping ? ` (${mapping})` : ""}`]
}

const renderNotes = schema => {
  const notes = [
    ...NOTE_KEYWORDS.flatMap(keyword => renderKeywordNote(schema, keyword)),
    ...renderDiscriminatorNote(schema.discriminator),
    ...(schema.default === undefined
      ? []
      : [`default: ${JSON.stringify(schema.default)}`]),
  ]
  return notes.length ? ` (${notes.join(", ")})` : ""
}

const renderAnnotation = schema => {
  const descriptionNote = schema.description
    ? ` — ${collapseWhitespace(schema.description)}`
    : ""
  return `${renderNotes(schema)}${descriptionNote}`
}

const renderObjectType = (schema, indent, context) => {
  const innerIndent = `${indent}  `
  const requiredNames = schema.required
  const propertyLines = Object.entries(schema.properties || {}).map(
    ([propertyName, propertySchema]) => {
      const isOptional = !(
        Array.isArray(requiredNames) && requiredNames.includes(propertyName)
      )
      return `${innerIndent}${propertyName}${isOptional ? "?" : ""}: ${renderAnnotatedType(propertySchema, innerIndent, context)}`
    }
  )
  const additionalSchema = schema.additionalProperties
  const additionalLines =
    additionalSchema && typeof additionalSchema === "object"
      ? [
          `${innerIndent}[key: string]: ${renderAnnotatedType(additionalSchema, innerIndent, context)}`,
        ]
      : []
  const lines = [...propertyLines, ...additionalLines]
  if (!lines.length) return "object"
  return `{\n${lines.join("\n")}\n${indent}}`
}

const renderArrayType = (schema, indent, context) => {
  const itemType = renderType(schema.items, indent, context)
  return /^[\w.()]+(\[\])*$/.test(itemType)
    ? `${itemType}[]`
    : `Array<${itemType}>`
}

const renderCombinedType = (schemas, separator, indent, context) =>
  schemas.map(member => renderType(member, indent, context)).join(separator)

const hasSeveral = value => Array.isArray(value) && value.length > 1

const isNullable = schema => Boolean(schema.nullable || schema["x-nullable"])

const isUnion = schema =>
  !schema?.$ref &&
  Boolean(schema) &&
  (isNullable(schema) ||
    [schema.oneOf, schema.anyOf, schema.enum, schema.type].some(hasSeveral))

const parenthesizeIf = (condition, text) => (condition ? `(${text})` : text)

const OWN_SHAPE_KEYWORDS = [
  "properties",
  "additionalProperties",
  "items",
  "enum",
  "const",
]

const hasOwnShape = schema =>
  OWN_SHAPE_KEYWORDS.some(
    keyword => schema[keyword] !== undefined && schema[keyword] !== false
  )

const renderBaseType = (schema, indent, context) => {
  const unions = [schema.oneOf, schema.anyOf].filter(Array.isArray)
  const intersected = schema.allOf || []
  if (!unions.length && !intersected.length) {
    return renderOwnType(schema, indent, context)
  }
  const ownType = hasOwnShape(schema)
    ? renderOwnType(schema, indent, context)
    : "object"
  const factorCount =
    unions.length + intersected.length + (ownType === "object" ? 0 : 1)
  const isIntersection = factorCount > 1
  return [
    ...intersected.map(member =>
      parenthesizeIf(
        isIntersection && isUnion(member),
        renderType(member, indent, context)
      )
    ),
    ...unions.map(members =>
      parenthesizeIf(
        isIntersection && members.length > 1,
        renderCombinedType(members, UNION_SEPARATOR, indent, context)
      )
    ),
    ...(ownType === "object"
      ? []
      : [parenthesizeIf(hasSeveral(schema.enum), ownType)]),
  ].join(" & ")
}

const renderOwnType = (schema, indent, context) => {
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) {
    return schema.enum.map(value => JSON.stringify(value)).join(UNION_SEPARATOR)
  }
  if (schema.type === "array" || schema.items) {
    return renderArrayType(schema, indent, context)
  }
  if (
    schema.type === "object" ||
    schema.properties ||
    schema.additionalProperties
  ) {
    return renderObjectType(schema, indent, context)
  }
  const typeName = [].concat(schema.type || "unknown").join(UNION_SEPARATOR)
  return schema.format ? `${typeName}(${schema.format})` : typeName
}

const renderType = (schema, indent, context) => {
  if (!schema) return "unknown"
  if (schema.$ref) {
    context.references.add(schema.$ref)
    return referenceName(schema.$ref)
  }
  const addsNull = isNullable(schema) && !schema.enum?.includes(null)
  return `${renderBaseType(schema, indent, context)}${addsNull ? `${UNION_SEPARATOR}null` : ""}`
}

const renderAnnotatedType = (schema, indent, context) =>
  `${renderType(schema, indent, context)}${renderAnnotation(schema || {})}`

const parameterSchema = parameter => {
  const { required, ...swaggerTwoSchema } = parameter
  const baseSchema = parameter.schema || swaggerTwoSchema
  return {
    ...baseSchema,
    enum: baseSchema.enum || parameter.enum,
    deprecated: baseSchema.deprecated || parameter.deprecated,
    description: parameter.description,
  }
}

const renderParameters = (parameters, context) => {
  const linesByLocation = parameters.reduce((groups, parameter) => {
    const line = `  ${parameter.name}${parameter.required ? "" : "?"}: ${renderAnnotatedType(parameterSchema(parameter), "  ", context)}`
    return {
      ...groups,
      [parameter.in]: [...(groups[parameter.in] || []), line],
    }
  }, {})
  return Object.entries(linesByLocation).flatMap(([location, lines]) => [
    `${location}:`,
    ...lines,
  ])
}

const mediaTypeLabel = mediaType =>
  mediaType === JSON_MEDIA_TYPE ? "" : ` (${mediaType})`

const renderRequestBody = (requestBodyNode, context) => {
  if (!requestBodyNode) return []
  const requestBody = dereference(context.spec, requestBodyNode)
  if (!requestBody) return [`body: ${describeUnresolved(requestBodyNode.$ref)}`]
  return Object.entries(requestBody.content || {}).map(([mediaType, media]) => {
    const annotation = renderAnnotation({
      ...media.schema,
      description: media.schema?.description || requestBody.description,
    })
    return `body${requestBody.required ? "" : "?"}${mediaTypeLabel(mediaType)}: ${renderType(media.schema, "", context)}${annotation}`
  })
}

const HEADER_INDENT = "    "

const renderHeaders = (headers, context) =>
  Object.entries(headers || {}).map(([headerName, headerNode]) => {
    const header = dereference(context.spec, headerNode)
    if (!header) {
      return `${HEADER_INDENT}header ${headerName}: ${describeUnresolved(headerNode?.$ref)}`
    }
    return `${HEADER_INDENT}header ${headerName}${header.required ? "" : "?"}: ${renderAnnotatedType(parameterSchema(header), HEADER_INDENT, context)}`
  })

const renderResponse = (statusCode, responseNode, context) => {
  const response = dereference(context.spec, responseNode)
  if (!response) {
    return [`  ${statusCode}: ${describeUnresolved(responseNode?.$ref)}`]
  }
  const heading = `  ${statusCode}${response.description ? ` — ${collapseWhitespace(response.description)}` : ""}`
  const headerLines = renderHeaders(response.headers, context)
  const contentEntries = Object.entries(response.content || {})
  if (contentEntries.length) {
    return [
      ...contentEntries.map(
        ([mediaType, media]) =>
          `${heading}${mediaTypeLabel(mediaType)}: ${renderType(media.schema, "  ", context)}`
      ),
      ...headerLines,
    ]
  }
  if (response.schema) {
    return [
      `${heading}: ${renderType(response.schema, "  ", context)}`,
      ...headerLines,
    ]
  }
  return [heading, ...headerLines]
}

const renderResponses = (responses, context) => {
  const responseLines = Object.entries(responses || {}).flatMap(
    ([statusCode, responseNode]) =>
      renderResponse(statusCode, responseNode, context)
  )
  return responseLines.length ? ["responses:", ...responseLines] : []
}

const NO_AUTH = "none"

const describeSecurityScheme = scheme => {
  if (!scheme) return ""
  if (scheme.type === "apiKey") return `apiKey in ${scheme.in} "${scheme.name}"`
  if (scheme.type === "http") {
    return ["http", scheme.scheme, scheme.bearerFormat].filter(Boolean).join(" ")
  }
  if (scheme.type === "basic") return "http basic"
  return scheme.type || ""
}

const renderSecurityScheme = (spec, schemeName, scopes) => {
  const schemes = spec.components?.securitySchemes || spec.securityDefinitions
  const details = [
    describeSecurityScheme(dereference(spec, schemes?.[schemeName])),
    scopes?.length ? `scopes: ${scopes.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("; ")
  return details ? `${schemeName} (${details})` : schemeName
}

const renderSecurityRequirement = (spec, requirement) =>
  Object.entries(requirement)
    .map(([schemeName, scopes]) =>
      renderSecurityScheme(spec, schemeName, scopes)
    )
    .join(" + ") || NO_AUTH

const renderAuth = (spec, operation) => {
  const security = operation.security || spec.security
  if (!security) return []
  const alternatives = security.map(requirement =>
    renderSecurityRequirement(spec, requirement)
  )
  return [`auth: ${alternatives.join(UNION_SEPARATOR) || NO_AUTH}`]
}

const renderOperation = (entry, pathItem, context) => {
  const { operation } = entry
  const parameterNodes = [
    ...(pathItem.parameters || []),
    ...(operation.parameters || []),
  ]
  const parameters = parameterNodes
    .map(parameter => dereference(context.spec, parameter))
    .filter(Boolean)
  const unresolvedParameters = parameterNodes
    .filter(parameter => !dereference(context.spec, parameter))
    .map(parameter => `parameter: ${describeUnresolved(parameter?.$ref)}`)
  const description =
    operation.description && operation.description !== operation.summary
      ? [collapseWhitespace(operation.description)]
      : []
  return [
    renderOperationLine(entry),
    ...(operation.deprecated ? ["deprecated"] : []),
    ...description,
    ...renderAuth(context.spec, operation),
    ...renderParameters(parameters, context),
    ...unresolvedParameters,
    ...renderRequestBody(operation.requestBody, context),
    ...renderResponses(operation.responses, context),
  ].join("\n")
}

const renderSchemaBlock = (reference, context) => {
  const schema = resolvePointer(context.spec, reference)
  const name = referenceName(reference)
  if (!schema) return `${name} = unknown — ${describeUnresolved(reference)}`
  const comment = schema.description
    ? `// ${collapseWhitespace(schema.description)}\n`
    : ""
  return `${comment}${name} = ${renderType(schema, "", context)}${renderNotes(schema)}`
}

const describeOmitted = references => {
  const names = references.slice(0, MAX_OMITTED_NAMES).map(referenceName)
  const hiddenCount = references.length - names.length
  return `${names.join(", ")}${hiddenCount ? `, … ${hiddenCount} more` : ""}`
}

const renderReferencedSchemas = context => {
  const renderedReferences = new Set()
  const blocks = []
  let size = 0
  let isNested = false
  let pendingReferences = [...context.references]
  while (pendingReferences.length && size < COMPACT_SCHEMA_BUDGET) {
    pendingReferences.forEach(reference => {
      if (isNested && size >= COMPACT_SCHEMA_BUDGET) return
      const block = renderSchemaBlock(reference, context)
      renderedReferences.add(reference)
      blocks.push(block)
      size += block.length
    })
    isNested = true
    pendingReferences = [...context.references].filter(
      reference => !renderedReferences.has(reference)
    )
  }
  return pendingReferences.length
    ? [
        ...blocks,
        `Not expanded to keep the answer short (read them with get_schema): ${describeOmitted(pendingReferences)}`,
      ]
    : blocks
}

const collectWithinBudget = (spec, startNode) => {
  const included = new Map()
  let size = 0
  let isNested = false
  let pendingReferences = [...collectDirectReferences(startNode)]
  while (pendingReferences.length && (!isNested || size < RAW_SCHEMA_BUDGET)) {
    pendingReferences.forEach(reference => {
      if (isNested && size >= RAW_SCHEMA_BUDGET) return
      const target = resolvePointer(spec, reference)
      included.set(reference, target)
      size += JSON.stringify(target ?? null).length
    })
    isNested = true
    pendingReferences = [
      ...new Set(
        [...included.values()].flatMap(target => [
          ...collectDirectReferences(target),
        ])
      ),
    ].filter(reference => !included.has(reference))
  }
  return {
    referenced: Object.fromEntries(included),
    omitted: pendingReferences,
  }
}

const stringifyRaw = (spec, startNode, document) => {
  const { referenced, omitted } = collectWithinBudget(spec, startNode)
  return stringify({
    ...document,
    ...(Object.keys(referenced).length ? { referenced } : {}),
    ...(omitted.length
      ? { "not expanded (read them with get_schema)": describeOmitted(omitted) }
      : {}),
  }).trimEnd()
}

export function collectDirectReferences(node, references = new Set()) {
  if (!node || typeof node !== "object") return references
  if (typeof node.$ref === "string") references.add(node.$ref)
  Object.values(node).forEach(child =>
    collectDirectReferences(child, references)
  )
  return references
}

export const renderSchema = (spec, reference) =>
  renderReferencedSchemas({ spec, references: new Set([reference]) }).join(
    "\n\n"
  )

export const renderRawSchema = (spec, reference) =>
  stringifyRaw(spec, { $ref: reference }, {})

const selectPathItem = (pathItem, method) => {
  if (!method) return pathItem
  return Object.fromEntries(
    Object.entries(pathItem).filter(
      ([key]) => !HTTP_METHODS.includes(key) || key === method
    )
  )
}

export const renderRawEndpoint = (spec, specPath, method) => {
  const pathItem = selectPathItem(spec.paths[specPath], method)
  return stringifyRaw(spec, pathItem, { [specPath]: pathItem })
}

export const renderEndpoint = (spec, specPath, method) => {
  const pathItem = getPathItem(spec, specPath)
  if (pathItem.$ref) {
    return `${specPath}: path item is an ${describeUnresolved(pathItem.$ref)}`
  }
  const context = { spec, references: new Set() }
  const operationBlocks = HTTP_METHODS.filter(
    candidate => pathItem[candidate] && (!method || candidate === method)
  ).map(candidate =>
    renderOperation(
      { specPath, method: candidate, operation: pathItem[candidate] },
      pathItem,
      context
    )
  )
  return [...operationBlocks, ...renderReferencedSchemas(context)].join("\n\n")
}
