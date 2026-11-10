#!/usr/bin/env node
import { searchOperations } from "../src/search.js"
import { listOperations } from "../src/render.js"
import { readSpec } from "../src/spec.js"
import { QUERY_SETS } from "./search-queries.js"

// The tool shows up to 50 endpoints that match every word, or the 15
// closest ones otherwise; an answer further down is never seen.
const SHOWN_WHEN_COMPLETE = 50
const SHOWN_WHEN_PARTIAL = 15
const CUTOFFS = [1, 5, 10]
const ALL_TYPES = "all"

const operationKey = ({ method, specPath }) =>
  `${method.toUpperCase()} ${specPath}`

const rankOf = (spec, { query, expected }) => {
  const { isComplete, matches } = searchOperations(spec, query)
  const shown = matches.slice(
    0,
    isComplete ? SHOWN_WHEN_COMPLETE : SHOWN_WHEN_PARTIAL
  )
  const position = shown.findIndex(entry =>
    expected.includes(operationKey(entry))
  )
  return {
    rank: position === -1 ? null : position + 1,
    top: shown[0] ? operationKey(shown[0]) : "nothing",
  }
}

const summarise = results => ({
  count: results.length,
  hits: CUTOFFS.map(
    cutoff =>
      results.filter(({ rank }) => rank !== null && rank <= cutoff).length /
      results.length
  ),
  meanReciprocalRank:
    results.reduce((total, { rank }) => total + (rank ? 1 / rank : 0), 0) /
    results.length,
})

const percent = share => `${Math.round(share * 100)}%`

const formatRow = (label, results) => {
  const { count, hits, meanReciprocalRank } = summarise(results)
  return `| ${[label, count, ...hits.map(percent), meanReciprocalRank.toFixed(2)].join(" | ")} |`
}

const HEADER = `| Query type | Queries | ${CUTOFFS.map(cutoff => `Top-${cutoff}`).join(" | ")} | MRR |
|---|---:|---:|---:|---:|---:|`

const printTable = (title, results) => {
  const types = [...new Set(results.map(({ type }) => type))]
  console.log(`\n### ${title}\n\n${HEADER}`)
  types.forEach(type =>
    console.log(formatRow(type, results.filter(result => result.type === type)))
  )
  console.log(formatRow(`**${ALL_TYPES}**`, results))
}

const printMisses = results => {
  const misses = results.filter(({ rank }) => rank === null || rank > 1)
  if (!misses.length) return
  console.log("\nQueries whose expected endpoint is not first:\n")
  misses.forEach(({ setName, type, query, rank, top }) =>
    console.log(
      `- [${setName}, ${type}] "${query}": ${rank ? `rank ${rank}` : "not shown"}; first result was ${top}`
    )
  )
}

const evaluateSet = ({ name, source, queries }) =>
  readSpec(source).then(spec => {
    const known = new Set(listOperations(spec).map(operationKey))
    const unknown = queries.flatMap(({ query, expected }) =>
      expected
        .filter(key => !known.has(key))
        .map(key => `"${query}" expects ${key}, which is not in ${name}`)
    )
    if (unknown.length) throw new Error(unknown.join("\n"))
    return queries.map(entry => ({
      ...entry,
      ...rankOf(spec, entry),
      setName: name,
    }))
  })

const showMisses = process.argv.includes("--misses")

QUERY_SETS.reduce(
  (previous, querySet) =>
    previous.then(results =>
      evaluateSet(querySet).then(setResults => {
        printTable(querySet.name, setResults)
        return [...results, ...setResults]
      })
    ),
  Promise.resolve([])
)
  .then(results => {
    printTable("All specs", results)
    console.log(
      `\nTop-N is the share of queries whose expected endpoint is among the first N results; MRR is the mean of 1 / rank (0 when the endpoint is not shown).`
    )
    if (showMisses) printMisses(results)
  })
  .catch(error => {
    console.error(error.message)
    process.exit(1)
  })
