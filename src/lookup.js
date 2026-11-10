import { listOperations } from "./render.js"

const MAX_SUGGESTIONS = 15

const trimSlashes = text => text.replace(/^\/+|\/+$/g, "")

const cleanPath = rawPath => {
  const withoutOrigin = rawPath.trim().replace(/^https?:\/\/[^/]+/, "")
  return `/${trimSlashes(withoutOrigin.split(/[?#]/)[0])}`
}

const basePathOf = serverUrl => {
  const withoutOrigin = String(serverUrl).replace(/^[a-z]+:\/\/[^/]+/i, "")
  return `/${trimSlashes(withoutOrigin)}`
}

const listBasePaths = spec =>
  [
    ...(spec.servers || []).map(server => basePathOf(server.url || "")),
    spec.basePath ? basePathOf(spec.basePath) : "/",
  ].filter(basePath => basePath !== "/")

const candidatePaths = (spec, rawPath) => {
  const requestedPath = cleanPath(rawPath)
  const withoutBasePath = listBasePaths(spec)
    .filter(basePath => requestedPath.startsWith(`${basePath}/`))
    .map(basePath => requestedPath.slice(basePath.length))
  return [...new Set([requestedPath, ...withoutBasePath])]
}

const isPlaceholder = segment => /^\{.*\}$/.test(segment)

const matchesTemplate = (specPath, requestedPath) => {
  const specSegments = specPath.split("/")
  const requestedSegments = requestedPath.split("/")
  if (specSegments.length !== requestedSegments.length) return false
  return specSegments.every(
    (specSegment, index) =>
      specSegment === requestedSegments[index] || isPlaceholder(specSegment)
  )
}

const findForCandidate = (spec, requestedPath) => {
  if (spec.paths[requestedPath]) return [requestedPath]
  return Object.keys(spec.paths).filter(specPath =>
    matchesTemplate(trimSlashes(specPath), trimSlashes(requestedPath))
  )
}

export const findSpecPaths = (spec, rawPath) =>
  candidatePaths(spec, rawPath).reduce(
    (found, requestedPath) =>
      found.length ? found : findForCandidate(spec, requestedPath),
    []
  )

export const searchOperations = (spec, query) => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return listOperations(spec).filter(({ specPath, method, operation }) => {
    const searchableText = [
      method,
      specPath,
      operation.summary,
      operation.operationId,
      ...(operation.tags || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    return terms.every(term => searchableText.includes(term))
  })
}

export const suggestOperations = (spec, rawPath) => {
  const keywords = cleanPath(rawPath)
    .split("/")
    .filter(segment => segment.length > 2 && !/^[{:[$\d]/.test(segment))
    .map(segment => segment.toLowerCase())
  return listOperations(spec)
    .map(entry => ({
      entry,
      score: keywords.filter(keyword =>
        entry.specPath.toLowerCase().includes(keyword)
      ).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((first, second) => second.score - first.score)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry }) => entry)
}
