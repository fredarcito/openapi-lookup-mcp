import {
  findSpecPaths,
  searchOperations,
  suggestOperations,
} from "./lookup.js"
import {
  HTTP_METHODS,
  getPathItem,
  renderEndpoint,
  renderOperationLine,
  renderRawEndpoint,
  renderRawSchema,
  renderSchema,
  referenceName,
} from "./render.js"
import {
  findSchemaReferences,
  findSchemaUsers,
  listSchemaReferences,
  suggestSchemaReferences,
} from "./schemas.js"
import { describeSnapshot } from "./spec.js"

const MAX_SEARCH_RESULTS = 50
const MAX_PARTIAL_RESULTS = 15
const MAX_SCHEMA_USERS = 30
const MAX_SCHEMA_SUGGESTIONS = 30

const withFooter = (text, snapshot) =>
  `${text}\n\n${describeSnapshot(snapshot)}`

const withRetry = (store, forceRefresh, attempt) =>
  store.load(forceRefresh).then(snapshot => {
    const firstResult = attempt(snapshot)
    if (firstResult.found) return firstResult
    return store
      .reloadIfStale(snapshot)
      .then(latestSnapshot =>
        latestSnapshot ? attempt(latestSnapshot) : firstResult
      )
  })

const availableMethods = pathItem =>
  HTTP_METHODS.filter(method => pathItem[method])
    .map(method => method.toUpperCase())
    .join(", ")

const describeMissingMethod = (spec, specPaths, method) =>
  specPaths
    .map(
      specPath =>
        `${specPath} has no ${method.toUpperCase()}; available: ${availableMethods(getPathItem(spec, specPath))}`
    )
    .join("\n")

const describeNotFound = (spec, requestedPath) => {
  const suggestions = suggestOperations(spec, requestedPath)
  const closest = suggestions.length
    ? `\nClosest endpoints:\n${suggestions.map(renderOperationLine).join("\n")}`
    : ""
  return `No endpoint matches ${requestedPath}.${closest}`
}

const lookUpEndpoint = (snapshot, { path, method, raw }) => {
  const { spec } = snapshot
  const specPaths = findSpecPaths(spec, path)
  if (!specPaths.length) {
    return {
      found: false,
      isError: true,
      text: withFooter(describeNotFound(spec, path), snapshot),
    }
  }
  const matchingPaths = specPaths.filter(specPath => {
    const pathItem = getPathItem(spec, specPath)
    return !method || pathItem[method] || pathItem.$ref
  })
  if (!matchingPaths.length) {
    return {
      found: true,
      isError: true,
      text: withFooter(
        describeMissingMethod(spec, specPaths, method),
        snapshot
      ),
    }
  }
  const render = raw ? renderRawEndpoint : renderEndpoint
  return {
    found: true,
    isError: false,
    text: withFooter(
      matchingPaths
        .map(specPath => render(spec, specPath, method))
        .join("\n\n"),
      snapshot
    ),
  }
}

export const getEndpoint = (store, { path, method, raw, refresh }) =>
  withRetry(store, refresh, snapshot =>
    lookUpEndpoint(snapshot, {
      path,
      method: (method || "").toLowerCase(),
      raw,
    })
  )

const runSearch = (snapshot, query) => {
  const { isComplete, matches } = searchOperations(snapshot.spec, query)
  if (!matches.length) {
    return {
      found: false,
      isError: false,
      text: withFooter(`No endpoints match "${query}".`, snapshot),
    }
  }
  const shownMatches = matches.slice(
    0,
    isComplete ? MAX_SEARCH_RESULTS : MAX_PARTIAL_RESULTS
  )
  const hiddenCount = isComplete ? matches.length - shownMatches.length : 0
  const heading = isComplete
    ? ""
    : `No endpoint matches every word of "${query}"; closest matches:\n`
  const truncationNote = hiddenCount
    ? `\n… ${hiddenCount} more; add terms to narrow the search.`
    : ""
  return {
    found: isComplete,
    isError: false,
    text: withFooter(
      `${heading}${shownMatches.map(renderOperationLine).join("\n")}${truncationNote}`,
      snapshot
    ),
  }
}

export const searchEndpoints = (store, { query }) =>
  withRetry(store, false, snapshot => runSearch(snapshot, query))

const renderUsers = (label, entries) => {
  if (!entries.length) return []
  const hiddenCount = Math.max(0, entries.length - MAX_SCHEMA_USERS)
  return [
    `${label}:`,
    ...entries
      .slice(0, MAX_SCHEMA_USERS)
      .map(entry => `  ${renderOperationLine(entry)}`),
    ...(hiddenCount ? [`  … ${hiddenCount} more`] : []),
  ]
}

const describeSchemaUsers = (spec, reference) => {
  const { direct, indirect } = findSchemaUsers(spec, reference)
  const lines = [
    ...renderUsers("used directly by", direct),
    ...renderUsers("used through other schemas by", indirect),
  ]
  return lines.length ? lines.join("\n") : "not used by any endpoint"
}

const describeMissingSchema = (spec, name) => {
  const suggestions = suggestSchemaReferences(spec, name)
  const candidates = suggestions.length
    ? suggestions
    : listSchemaReferences(spec)
  const shownNames = candidates
    .slice(0, MAX_SCHEMA_SUGGESTIONS)
    .map(referenceName)
  const hiddenCount = candidates.length - shownNames.length
  const label = suggestions.length ? "Closest schemas" : "Available schemas"
  const list = shownNames.length
    ? `\n${label}: ${shownNames.join(", ")}${hiddenCount ? `, … ${hiddenCount} more` : ""}`
    : ""
  return `No schema is named ${name}.${list}`
}

const lookUpSchema = (snapshot, { name, raw }) => {
  const { spec } = snapshot
  const references = findSchemaReferences(spec, name)
  if (!references.length) {
    return {
      found: false,
      isError: true,
      text: withFooter(describeMissingSchema(spec, name), snapshot),
    }
  }
  const render = raw ? renderRawSchema : renderSchema
  return {
    found: true,
    isError: false,
    text: withFooter(
      references
        .map(
          reference =>
            `${render(spec, reference)}\n\n${referenceName(reference)} is ${describeSchemaUsers(spec, reference)}`
        )
        .join("\n\n"),
      snapshot
    ),
  }
}

export const getSchema = (store, { name, raw, refresh }) =>
  withRetry(store, refresh, snapshot => lookUpSchema(snapshot, { name, raw }))
