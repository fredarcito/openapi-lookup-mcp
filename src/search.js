import { resolvePointer } from "./render.js"
import { listOperationsWithSchemaNames } from "./schemas.js"

// Ranked keyword search over the operations of a spec. Every operation is
// indexed as a set of weighted fields and scored with BM25F, so words that
// are rare in the spec count for more and short, specific texts beat long
// ones. Query words also match through CRUD synonyms, prefixes and, when a
// word is unknown, close spellings.

const STOP_WORDS = new Set(
  "a an the i we you he she they it me my our your his her their its us them to of in on at by for from with into about as and or but if so than then is are was were be been being am has have had having can could do does did will shall may might must how what which who whom whose why that this these those there here when where need want would should like please just only also some any all each every one specific given endpoint endpoints api".split(
    " "
  )
)

const SYNONYMS = {
  retrieve: "get list",
  fetch: "get list",
  read: "get",
  show: "get list",
  view: "get",
  find: "get list search",
  list: "get",
  create: "post add",
  add: "post create",
  new: "post create",
  make: "post create",
  insert: "post create",
  update: "patch put edit",
  edit: "patch put update",
  modify: "patch put update",
  change: "patch put update",
  delete: "remove",
  remove: "delete",
  destroy: "delete remove",
  drop: "delete remove",
}

// weight: how much a match in the field counts.
// lengthPenalty: how much a long field dilutes a match (BM25's b).
const FIELDS = {
  method: { weight: 2, lengthPenalty: 0 },
  path: { weight: 3, lengthPenalty: 0.5 },
  operationId: { weight: 2.5, lengthPenalty: 0.5 },
  summary: { weight: 3, lengthPenalty: 0.75 },
  tags: { weight: 1.5, lengthPenalty: 0 },
  parameters: { weight: 1.5, lengthPenalty: 0.3 },
  schemas: { weight: 1.5, lengthPenalty: 0 },
  description: { weight: 0.5, lengthPenalty: 0.5 },
  properties: { weight: 0.3, lengthPenalty: 0 },
  related: { weight: 0.15, lengthPenalty: 0 },
}

// Fields that say what an endpoint is about. How rare a word is gets
// measured on these, so a word that merely shows up in many response
// bodies ("created", "id") is not mistaken for a common topic.
const CORE_FIELDS = new Set([
  "method",
  "path",
  "operationId",
  "summary",
  "tags",
  "parameters",
  "schemas",
])

const SATURATION = 3
const SYNONYM_FACTOR = 0.7
const PREFIX_FACTOR = 0.6
const FUZZY_FACTOR = 0.5
const MIN_PREFIX_LENGTH = 4
const MIN_FUZZY_LENGTH = 4
const LONG_WORD_LENGTH = 8
const MAX_FUZZY_CANDIDATES = 3
const PROPERTY_DEPTH = 2
const MAX_PROPERTY_NAMES = 300

const splitWords = text =>
  String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1)

const stripPlural = word => {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (/(ss|ch|sh|x|z)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) {
    return word.slice(0, -1)
  }
  return word
}

const stripVerbEnding = word => {
  const [, base] = word.match(/^(.{3,})(?:ing|ed)$/) || []
  return base && /[aeiouy]/.test(base) ? base : word
}

// A light stemmer: it only has to map the forms of a word to the same
// string, not to a real word ("creating", "created", "creates" → "creat").
export const stem = word => {
  const base = stripVerbEnding(stripPlural(word))
  const withoutFinalE =
    base.length > 3 && base.endsWith("e") && !base.endsWith("ee")
      ? base.slice(0, -1)
      : base
  return withoutFinalE.replace(/([^aeioulsz])\1$/, "$1")
}

const toWords = text =>
  splitWords(text).filter(word => !STOP_WORDS.has(word))

const collectPropertyNames = (spec, schemaNode, depth, names) => {
  const schema = schemaNode?.$ref
    ? resolvePointer(spec, schemaNode.$ref)
    : schemaNode
  if (!schema || typeof schema !== "object") return names
  if (names.length >= MAX_PROPERTY_NAMES) return names
  ;[schema.items, ...[schema.allOf, schema.oneOf, schema.anyOf].flat()]
    .filter(Boolean)
    .forEach(member => collectPropertyNames(spec, member, depth, names))
  Object.entries(schema.properties || {}).forEach(
    ([propertyName, propertySchema]) => {
      names.push(propertyName)
      if (depth > 1) {
        collectPropertyNames(spec, propertySchema, depth - 1, names)
      }
    }
  )
  return names
}

const dereference = (spec, node) =>
  node?.$ref ? resolvePointer(spec, node.$ref) : node

const bodySchemasOf = (spec, operation, parameters) => {
  const requestBody = dereference(spec, operation.requestBody)
  const responses = Object.entries(operation.responses || {})
    .filter(([statusCode]) => /^2|^default$/.test(statusCode))
    .map(([, response]) => dereference(spec, response))
    .filter(Boolean)
  return [
    ...Object.values(requestBody?.content || {}).map(media => media?.schema),
    ...parameters
      .filter(parameter => parameter.in === "body")
      .map(parameter => parameter.schema),
    ...responses.flatMap(response => [
      response.schema,
      ...Object.values(response.content || {}).map(media => media?.schema),
    ]),
  ].filter(Boolean)
}

// A path parameter is a placeholder for the resource the path already
// names, so it is only weak evidence of what the endpoint is about.
const isNotInPath = parameter => parameter.in !== "path"

const fieldTextsOf = (spec, { entry, schemaNames, nestedSchemaNames }) => {
  const { specPath, method, operation, pathItem } = entry
  const parameters = [
    ...(pathItem.parameters || []),
    ...(operation.parameters || []),
  ]
    .map(parameter => dereference(spec, parameter))
    .filter(Boolean)
  const propertyNames = bodySchemasOf(spec, operation, parameters).flatMap(
    schema => collectPropertyNames(spec, schema, PROPERTY_DEPTH, [])
  )
  return {
    method: [method],
    path: [specPath.replace(/\{[^}]*\}/g, " ")],
    operationId: [operation.operationId],
    summary: [operation.summary],
    tags: operation.tags || [],
    parameters: parameters.filter(isNotInPath).map(parameter => parameter.name),
    schemas: schemaNames,
    description: [operation.description],
    properties: propertyNames.slice(0, MAX_PROPERTY_NAMES),
    related: [
      ...nestedSchemaNames,
      ...parameters
        .filter(parameter => !isNotInPath(parameter))
        .map(parameter => parameter.name),
      ...parameters.map(parameter => parameter.description),
    ],
  }
}

const countTokens = tokens =>
  tokens.reduce(
    (counts, token) => counts.set(token, (counts.get(token) || 0) + 1),
    new Map()
  )

const buildIndex = spec => {
  // spellings: token → the first full word that produced it, for messages
  const spellings = new Map()
  const toTokens = text =>
    toWords(text).map(word => {
      const token = stem(word)
      if (!spellings.has(token)) spellings.set(token, word)
      return token
    })
  const documents = listOperationsWithSchemaNames(spec).map(operation => {
    const texts = fieldTextsOf(spec, operation)
    return {
      entry: operation.entry,
      fields: Object.fromEntries(
        Object.keys(FIELDS).map(fieldName => [
          fieldName,
          texts[fieldName].filter(Boolean).flatMap(toTokens),
        ])
      ),
    }
  })
  const averageLengths = Object.fromEntries(
    Object.keys(FIELDS).map(fieldName => [
      fieldName,
      documents.reduce(
        (total, { fields }) => total + fields[fieldName].length,
        0
      ) / (documents.length || 1) || 1,
    ])
  )
  // postings: token → Map(document index → field-weighted term frequency)
  // coreDocuments: token → documents that have it in a core field
  const postings = new Map()
  const coreDocuments = new Map()
  documents.forEach(({ fields }, documentIndex) =>
    Object.entries(FIELDS).forEach(([fieldName, { weight, lengthPenalty }]) => {
      const tokens = fields[fieldName]
      const lengthNorm =
        1 -
        lengthPenalty +
        (lengthPenalty * tokens.length) / averageLengths[fieldName]
      countTokens(tokens).forEach((count, token) => {
        if (!postings.has(token)) {
          postings.set(token, new Map())
          coreDocuments.set(token, new Set())
        }
        if (CORE_FIELDS.has(fieldName)) {
          coreDocuments.get(token).add(documentIndex)
        }
        const tokenPostings = postings.get(token)
        tokenPostings.set(
          documentIndex,
          (tokenPostings.get(documentIndex) || 0) +
            (weight * count) / lengthNorm
        )
      })
    })
  )
  return {
    entries: documents.map(({ entry }) => entry),
    postings,
    coreDocuments,
    spellings,
    vocabulary: [...postings.keys()],
  }
}

const indexBySpec = new WeakMap()

const indexOf = spec => {
  if (!indexBySpec.has(spec)) indexBySpec.set(spec, buildIndex(spec))
  return indexBySpec.get(spec)
}

// Optimal string alignment distance, abandoned once it exceeds the limit.
const editDistance = (first, second, limit) => {
  if (Math.abs(first.length - second.length) > limit) return limit + 1
  let beforePrevious = []
  let previous = Array.from({ length: second.length + 1 }, (unused, i) => i)
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= second.length; column += 1) {
      const cost = first[row - 1] === second[column - 1] ? 0 : 1
      const isSwap =
        row > 1 &&
        column > 1 &&
        first[row - 1] === second[column - 2] &&
        first[row - 2] === second[column - 1]
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
        isSwap ? beforePrevious[column - 2] + 1 : Infinity
      )
    }
    if (Math.min(...current) > limit) return limit + 1
    beforePrevious = previous
    previous = current
  }
  return previous[second.length]
}

const closestSpellings = (index, token) => {
  if (token.length < MIN_FUZZY_LENGTH) return []
  const limit = token.length >= LONG_WORD_LENGTH ? 2 : 1
  return index.vocabulary
    .map(candidate => ({
      candidate,
      distance: editDistance(token, candidate, limit),
    }))
    .filter(({ distance }) => distance <= limit)
    .sort(
      (first, second) =>
        first.distance - second.distance ||
        index.postings.get(second.candidate).size -
          index.postings.get(first.candidate).size
    )
    .slice(0, MAX_FUZZY_CANDIDATES)
    .map(({ candidate }) => candidate)
}

// The index tokens a query word can match, each with the share of the
// score it keeps: the word itself, its synonyms, longer words it starts,
// and close spellings when nothing else is known.
const candidatesOf = (index, word) => {
  const token = stem(word)
  const known = candidate => index.postings.has(candidate)
  const direct = [
    ...(known(token) ? [{ token, factor: 1 }] : []),
    ...(SYNONYMS[word] || "")
      .split(" ")
      .filter(Boolean)
      .map(stem)
      .filter(known)
      .map(synonym => ({ token: synonym, factor: SYNONYM_FACTOR })),
    ...(token.length >= MIN_PREFIX_LENGTH
      ? index.vocabulary
          .filter(
            candidate => candidate !== token && candidate.startsWith(token)
          )
          .map(candidate => ({ token: candidate, factor: PREFIX_FACTOR }))
      : []),
  ]
  if (direct.length) return { candidates: direct }
  const spellings = closestSpellings(index, token)
  return {
    candidates: spellings.map(spelling => ({
      token: spelling,
      factor: FUZZY_FACTOR,
    })),
    correctedTo: index.spellings.get(spellings[0]),
  }
}

// Scores every document for one query word. The word and its alternatives
// count as a single term: their frequencies are merged first, and rarity
// is measured on the merged set, so a rare synonym cannot outweigh the
// word that was actually asked for.
const scoreTerm = (index, candidates) => {
  const frequencies = new Map()
  const coreMatches = new Set()
  candidates.forEach(({ token, factor }) => {
    index.coreDocuments
      .get(token)
      .forEach(documentIndex => coreMatches.add(documentIndex))
    index.postings.get(token).forEach((frequency, documentIndex) => {
      frequencies.set(
        documentIndex,
        (frequencies.get(documentIndex) || 0) + factor * frequency
      )
    })
  })
  const documentCount = index.entries.length
  const matchCount = coreMatches.size || frequencies.size
  const rarity = Math.log(
    1 + (documentCount - matchCount + 0.5) / (matchCount + 0.5)
  )
  const scores = new Map()
  frequencies.forEach((frequency, documentIndex) =>
    scores.set(
      documentIndex,
      (rarity * frequency * (SATURATION + 1)) / (frequency + SATURATION)
    )
  )
  return scores
}

const queryWords = query => {
  const words = [...new Set(splitWords(query))]
  const meaningfulWords = words.filter(word => !STOP_WORDS.has(word))
  return meaningfulWords.length ? meaningfulWords : words
}

export const searchOperations = (spec, query) => {
  const index = indexOf(spec)
  const terms = queryWords(query).map(word => ({
    word,
    ...candidatesOf(index, word),
  }))
  const knownTerms = terms.filter(({ candidates }) => candidates.length)
  const totals = new Map()
  knownTerms.forEach(({ candidates }) =>
    scoreTerm(index, candidates).forEach((score, documentIndex) => {
      const total = totals.get(documentIndex) || { score: 0, matchedTerms: 0 }
      totals.set(documentIndex, {
        score: total.score + score,
        matchedTerms: total.matchedTerms + 1,
      })
    })
  )
  const ranked = [...totals]
    .map(([documentIndex, { score, matchedTerms }]) => ({
      entry: index.entries[documentIndex],
      matchedTerms,
      score: (score * matchedTerms) / knownTerms.length,
    }))
    .sort(
      (first, second) =>
        second.matchedTerms - first.matchedTerms || second.score - first.score
    )
  const complete = ranked.filter(
    ({ matchedTerms }) => matchedTerms === knownTerms.length
  )
  return {
    isComplete: complete.length > 0,
    matches: (complete.length ? complete : ranked).map(({ entry }) => entry),
    unknownWords: terms
      .filter(({ candidates }) => !candidates.length)
      .map(({ word }) => word),
    corrections: terms
      .filter(({ correctedTo }) => correctedTo)
      .map(({ word, correctedTo }) => ({ word, correctedTo })),
  }
}
