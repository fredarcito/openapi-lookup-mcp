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

const collapseWhitespace = text => String(text).replace(/\s+/g, " ").trim()

const resolvePointer = (spec, reference) =>
  reference
    .replace(/^#\//, "")
    .split("/")
    .map(key => key.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((node, key) => node?.[key], spec)

const dereference = (spec, node) =>
  node?.$ref ? resolvePointer(spec, node.$ref) : node

const referenceName = reference => reference.split("/").pop()

export const listOperations = spec =>
  Object.entries(spec.paths).flatMap(([specPath, pathItem]) =>
    HTTP_METHODS.filter(method => pathItem?.[method]).map(method => ({
      specPath,
      method,
      operation: pathItem[method],
    }))
  )

export const renderOperationLine = ({ specPath, method, operation }) => {
  const summary = operation.summary
    ? ` — ${collapseWhitespace(operation.summary)}`
    : ""
  return `${method.toUpperCase()} ${specPath}${summary}`
}

const renderAnnotation = schema => {
  const defaultNote =
    schema.default === undefined
      ? ""
      : ` (default: ${JSON.stringify(schema.default)})`
  const descriptionNote = schema.description
    ? ` — ${collapseWhitespace(schema.description)}`
    : ""
  return `${defaultNote}${descriptionNote}`
}

const renderObjectType = (schema, indent, context) => {
  const innerIndent = `${indent}  `
  const requiredNames = schema.required
  const propertyLines = Object.entries(schema.properties || {}).map(
    ([propertyName, propertySchema]) => {
      const isOptional =
        Array.isArray(requiredNames) && !requiredNames.includes(propertyName)
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

const renderBaseType = (schema, indent, context) => {
  if (schema.oneOf || schema.anyOf) {
    return renderCombinedType(
      schema.oneOf || schema.anyOf,
      UNION_SEPARATOR,
      indent,
      context
    )
  }
  if (schema.allOf) {
    return renderCombinedType(schema.allOf, " & ", indent, context)
  }
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
  const nullableSuffix = schema.nullable ? `${UNION_SEPARATOR}null` : ""
  return `${renderBaseType(schema, indent, context)}${nullableSuffix}`
}

const renderAnnotatedType = (schema, indent, context) =>
  `${renderType(schema, indent, context)}${schema?.$ref ? "" : renderAnnotation(schema || {})}`

const parameterSchema = parameter => {
  const baseSchema = parameter.schema || {
    type: parameter.type,
    format: parameter.format,
    items: parameter.items,
    default: parameter.default,
  }
  return {
    ...baseSchema,
    enum: baseSchema.enum || parameter.enum,
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

const renderRequestBody = (requestBody, context) => {
  if (!requestBody) return []
  return Object.entries(requestBody.content || {}).map(
    ([mediaType, media]) =>
      `body${requestBody.required ? "" : "?"}${mediaTypeLabel(mediaType)}: ${renderType(media.schema, "", context)}`
  )
}

const renderResponse = (statusCode, responseNode, context) => {
  const response = dereference(context.spec, responseNode) || {}
  const heading = `  ${statusCode}${response.description ? ` — ${collapseWhitespace(response.description)}` : ""}`
  const contentEntries = Object.entries(response.content || {})
  if (contentEntries.length) {
    return contentEntries.map(
      ([mediaType, media]) =>
        `${heading}${mediaTypeLabel(mediaType)}: ${renderType(media.schema, "  ", context)}`
    )
  }
  if (response.schema) {
    return [`${heading}: ${renderType(response.schema, "  ", context)}`]
  }
  return [heading]
}

const renderResponses = (responses, context) => {
  const responseLines = Object.entries(responses || {}).flatMap(
    ([statusCode, responseNode]) =>
      renderResponse(statusCode, responseNode, context)
  )
  return responseLines.length ? ["responses:", ...responseLines] : []
}

const renderAuth = (spec, operation) => {
  const security = operation.security || spec.security
  if (!security) return []
  const schemeNames = security.flatMap(Object.keys)
  return [
    `auth: ${schemeNames.length ? schemeNames.join(UNION_SEPARATOR) : "none"}`,
  ]
}

const renderOperation = (entry, pathItem, context) => {
  const { operation } = entry
  const parameters = [
    ...(pathItem.parameters || []),
    ...(operation.parameters || []),
  ].map(parameter => dereference(context.spec, parameter))
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
    ...renderRequestBody(
      dereference(context.spec, operation.requestBody),
      context
    ),
    ...renderResponses(operation.responses, context),
  ].join("\n")
}

const renderReferencedSchemas = context => {
  const renderedReferences = new Set()
  const blocks = []
  let pendingReferences = [...context.references]
  while (pendingReferences.length) {
    pendingReferences.forEach(reference => {
      renderedReferences.add(reference)
      blocks.push(
        `${referenceName(reference)} = ${renderType(resolvePointer(context.spec, reference), "", context)}`
      )
    })
    pendingReferences = [...context.references].filter(
      reference => !renderedReferences.has(reference)
    )
  }
  return blocks
}

const collectReferences = (spec, node, references) => {
  if (!node || typeof node !== "object") return references
  if (typeof node.$ref === "string" && !references.has(node.$ref)) {
    references.add(node.$ref)
    collectReferences(spec, resolvePointer(spec, node.$ref), references)
  }
  Object.values(node).forEach(child =>
    collectReferences(spec, child, references)
  )
  return references
}

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
  const references = [...collectReferences(spec, pathItem, new Set())]
  const referenced = Object.fromEntries(
    references.map(reference => [reference, resolvePointer(spec, reference)])
  )
  return stringify({
    [specPath]: pathItem,
    ...(references.length ? { referenced } : {}),
  }).trimEnd()
}

export const renderEndpoint = (spec, specPath, method) => {
  const pathItem = spec.paths[specPath]
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
