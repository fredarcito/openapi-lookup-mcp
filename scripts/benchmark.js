#!/usr/bin/env node
import { stringify } from "yaml"
import { searchOperations } from "../src/lookup.js"
import {
  listOperations,
  renderEndpoint,
  renderRawEndpoint,
  renderSchema,
} from "../src/render.js"
import { findSchemaUsers, listSchemaReferences } from "../src/schemas.js"
import { readSpec } from "../src/spec.js"

const DEFAULT_SOURCES = [
  "https://petstore.swagger.io/v2/swagger.json",
  "https://petstore3.swagger.io/api/v3/openapi.json",
  "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
]

const CHARACTERS_PER_TOKEN = 4
const UNRESOLVED_PATTERN = /unresolved reference/g
const TRUNCATED_PATTERN = /^Not expanded to keep the answer short/m

const sum = values => values.reduce((total, value) => total + value, 0)

const median = values => {
  const sorted = [...values].sort((first, second) => first - second)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
}

const toTokens = characters => Math.round(characters / CHARACTERS_PER_TOKEN)

const attempt = (label, action) => {
  try {
    return { text: action() }
  } catch (error) {
    return { failure: `${label}: ${error.message}` }
  }
}

const measure = spec => {
  const startedAt = Date.now()
  const endpoints = listOperations(spec).map(({ specPath, method }) => ({
    compact: attempt(`${method.toUpperCase()} ${specPath}`, () =>
      renderEndpoint(spec, specPath, method)
    ),
    raw: attempt(`${method.toUpperCase()} ${specPath} (raw)`, () =>
      renderRawEndpoint(spec, specPath, method)
    ),
  }))
  const schemaReferences = listSchemaReferences(spec)
  const schemas = schemaReferences.map(reference =>
    attempt(reference, () => renderSchema(spec, reference))
  )
  const extras = [
    attempt("search", () => String(searchOperations(spec, "list").matches.length)),
    ...schemaReferences
      .slice(0, 1)
      .map(reference =>
        attempt("schema users", () =>
          String(findSchemaUsers(spec, reference).direct.length)
        )
      ),
  ]
  const results = [
    ...endpoints.flatMap(({ compact, raw }) => [compact, raw]),
    ...schemas,
    ...extras,
  ]
  const measured = endpoints.filter(({ compact, raw }) => compact.text && raw.text)
  const compactSizes = measured.map(({ compact }) => compact.text.length)
  const rawSizes = measured.map(({ raw }) => raw.text.length)
  return {
    endpointCount: endpoints.length,
    schemaCount: schemas.length,
    failures: results.filter(({ failure }) => failure).map(({ failure }) => failure),
    unresolvedCount: sum(
      results.map(({ text }) => (text?.match(UNRESOLVED_PATTERN) || []).length)
    ),
    truncatedCount: measured.filter(({ compact }) =>
      TRUNCATED_PATTERN.test(compact.text)
    ).length,
    maxCompactTokens: toTokens(Math.max(0, ...compactSizes)),
    specTokens: toTokens(stringify(spec).length),
    medianRawTokens: toTokens(median(rawSizes)),
    medianCompactTokens: toTokens(median(compactSizes)),
    compactShare: sum(rawSizes) ? sum(compactSizes) / sum(rawSizes) : 0,
    elapsedMs: Date.now() - startedAt,
  }
}

const formatRow = (source, stats) =>
  `| ${[
    source.split("/").slice(2, 5).join("/"),
    stats.endpointCount,
    stats.schemaCount,
    stats.failures.length,
    stats.unresolvedCount,
    stats.specTokens.toLocaleString("en-US"),
    stats.medianRawTokens.toLocaleString("en-US"),
    stats.medianCompactTokens.toLocaleString("en-US"),
    stats.maxCompactTokens.toLocaleString("en-US"),
    stats.truncatedCount,
    `${Math.round(stats.compactShare * 100)}%`,
    `${stats.elapsedMs} ms`,
  ].join(" | ")} |`

const HEADER = `| Spec | Endpoints | Schemas | Render failures | Unresolved refs | Whole spec (tokens) | Median endpoint, raw YAML | Median endpoint, compact | Largest endpoint, compact | Endpoints over the schema budget | Compact / raw | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|`

const sources = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_SOURCES

const run = () =>
  sources
    .reduce(
      (previous, source) =>
        previous.then(rows =>
          readSpec(source).then(spec => {
            const stats = measure(spec)
            stats.failures
              .slice(0, 10)
              .forEach(failure => console.error(`${source}: ${failure}`))
            return [...rows, { source, stats }]
          })
        ),
      Promise.resolve([])
    )
    .then(rows => {
      console.log(HEADER)
      rows.forEach(({ source, stats }) => console.log(formatRow(source, stats)))
      console.log(
        `\nTokens are estimated as characters / ${CHARACTERS_PER_TOKEN}. "Compact / raw" compares the total size of every endpoint in both formats.`
      )
      const failureCount = sum(rows.map(({ stats }) => stats.failures.length))
      process.exit(failureCount ? 1 : 0)
    })

run().catch(error => {
  console.error(error.message)
  process.exit(1)
})
