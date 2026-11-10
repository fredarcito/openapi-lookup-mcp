import { listOperations } from "./render.js"
import { listOperationsWithSchemaNames } from "./schemas.js"

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

const STOP_WORDS = new Set(
  "a an the i we you it me my our to of in on at by for from with and or is are be can do does how what which who that this these those need want would like some any all each every specific given endpoint endpoints api".split(
    " "
  )
)

const METHOD_SYNONYMS = {
  retrieve: "get",
  fetch: "get",
  read: "get",
  show: "get",
  list: "get",
  find: "get",
  create: "post",
  add: "post",
  new: "post",
  update: "patch put",
  edit: "patch put",
  modify: "patch put",
  change: "patch put",
  replace: "put",
  remove: "delete",
  destroy: "delete",
}

const FIELD_WEIGHTS = { strong: 3, medium: 2, weak: 1 }

const singular = word => {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3)
  if (/(ss|ch|sh|x)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1)
  }
  return word
}

const queryTerms = query => {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_{}/.-]+/)
    .filter(Boolean)
  const meaningfulWords = words.filter(word => !STOP_WORDS.has(word))
  return [...new Set(meaningfulWords.length ? meaningfulWords : words)].map(
    word => ({
      text: singular(word),
      methods: (METHOD_SYNONYMS[word] || "").split(" ").filter(Boolean),
    })
  )
}

const joinLower = values => values.filter(Boolean).join(" ").toLowerCase()

const searchFieldsOf = (entry, schemaNames) => {
  const { specPath, method, operation, pathItem } = entry
  const parameters = [
    ...(pathItem.parameters || []),
    ...(operation.parameters || []),
  ]
  return {
    method,
    strong: joinLower([method, specPath, operation.operationId]),
    medium: joinLower([operation.summary, ...(operation.tags || [])]),
    weak: joinLower([
      operation.description,
      ...parameters.map(parameter => parameter?.name),
      ...schemaNames,
    ]),
  }
}

const searchIndexBySpec = new WeakMap()

const searchIndexOf = spec => {
  if (!searchIndexBySpec.has(spec)) {
    searchIndexBySpec.set(
      spec,
      listOperationsWithSchemaNames(spec).map(({ entry, schemaNames }) => ({
        entry,
        fields: searchFieldsOf(entry, schemaNames),
      }))
    )
  }
  return searchIndexBySpec.get(spec)
}

const termScore = (fields, term) => {
  const fieldName = Object.keys(FIELD_WEIGHTS).find(candidate =>
    fields[candidate].includes(term.text)
  )
  if (fieldName) return FIELD_WEIGHTS[fieldName]
  return term.methods.includes(fields.method) ? FIELD_WEIGHTS.weak : 0
}

export const searchOperations = (spec, query) => {
  const terms = queryTerms(query)
  const ranked = searchIndexOf(spec)
    .map(({ entry, fields }) => {
      const scores = terms.map(term => termScore(fields, term))
      return {
        entry,
        matchedTerms: scores.filter(Boolean).length,
        score: scores.reduce((total, score) => total + score, 0),
      }
    })
    .filter(({ matchedTerms }) => matchedTerms > 0)
    .sort(
      (first, second) =>
        second.matchedTerms - first.matchedTerms || second.score - first.score
    )
  const complete = ranked.filter(
    ({ matchedTerms }) => matchedTerms === terms.length
  )
  return {
    isComplete: complete.length > 0,
    matches: (complete.length ? complete : ranked).map(({ entry }) => entry),
  }
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
