import {
  findSpecPaths,
  searchOperations,
  suggestOperations,
} from "./lookup.js"
import {
  HTTP_METHODS,
  renderEndpoint,
  renderOperationLine,
  renderRawEndpoint,
} from "./render.js"
import { describeSnapshot } from "./spec.js"

const MAX_SEARCH_RESULTS = 50

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
        `${specPath} has no ${method.toUpperCase()}; available: ${availableMethods(spec.paths[specPath])}`
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
  const matchingPaths = specPaths.filter(
    specPath => !method || spec.paths[specPath][method]
  )
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
  const matches = searchOperations(snapshot.spec, query)
  if (!matches.length) {
    return {
      found: false,
      isError: false,
      text: withFooter(`No endpoints match "${query}".`, snapshot),
    }
  }
  const shownMatches = matches.slice(0, MAX_SEARCH_RESULTS)
  const hiddenCount = matches.length - shownMatches.length
  const truncationNote = hiddenCount
    ? `\n… ${hiddenCount} more; add terms to narrow the search.`
    : ""
  return {
    found: true,
    isError: false,
    text: withFooter(
      `${shownMatches.map(renderOperationLine).join("\n")}${truncationNote}`,
      snapshot
    ),
  }
}

export const searchEndpoints = (store, { query }) =>
  withRetry(store, false, snapshot => runSearch(snapshot, query))
