import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { stem } from "../src/search.js"
import { createSpecStore } from "../src/spec.js"
import { getEndpoint, getSchema, searchEndpoints } from "../src/tools.js"

const schemaReference = name => ({ $ref: `#/components/schemas/${name}` })

const jsonContent = schema => ({ "application/json": { schema } })

const SPEC = {
  openapi: "3.0.3",
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      oauth: { type: "oauth2", flows: {} },
    },
    headers: {
      rateLimit: { description: "requests left", schema: { type: "integer" } },
    },
    responses: {
      matches: {
        description: "matching candidates",
        content: jsonContent({
          type: "array",
          items: schemaReference("JobMatch"),
        }),
      },
    },
    schemas: {
      JobMatch: {
        type: "object",
        properties: {
          score: { type: "number" },
          candidate: schemaReference("CandidateProfile"),
        },
      },
      CandidateProfile: {
        type: "object",
        properties: { fullName: { type: "string" } },
      },
      Orphan: { type: "object", properties: { id: { type: "string" } } },
    },
  },
  paths: {
    "/jobs/{jobId}/matches": {
      get: {
        operationId: "listJobMatches",
        summary: "Ranked matches",
        description: "Returns the applicants that fit the opening.",
        parameters: [
          { name: "jobId", in: "path", required: true, schema: { type: "string" } },
          { name: "minScore", in: "query", schema: { type: "number" } },
        ],
        responses: { 200: { $ref: "#/components/responses/matches" } },
      },
    },
    "/candidates": {
      post: {
        summary: "Create a candidate",
        security: [{ apiKey: [], oauth: ["write:candidates"] }, {}],
        requestBody: { content: jsonContent(schemaReference("CandidateProfile")) },
        responses: {
          201: {
            description: "created",
            headers: {
              "X-RateLimit-Remaining": { $ref: "#/components/headers/rateLimit" },
              Location: { required: true, schema: { type: "string", format: "uri" } },
            },
          },
        },
      },
    },
    "/jobs": {
      get: { summary: "List jobs", responses: { 200: { description: "ok" } } },
      delete: { summary: "Delete jobs", responses: { 204: { description: "ok" } } },
    },
  },
}

const writeSpecFiles = files =>
  mkdtemp(path.join(os.tmpdir(), "openapi-lookup-")).then(directory =>
    Promise.all(
      Object.entries(files).map(([fileName, content]) =>
        writeFile(path.join(directory, fileName), JSON.stringify(content))
      )
    ).then(() => createSpecStore(path.join(directory, "spec.json")))
  )

const createStore = spec => writeSpecFiles({ "spec.json": spec })

const search = query =>
  createStore(SPEC)
    .then(store => searchEndpoints(store, { query }))
    .then(result => result.text)

test("finds endpoints through descriptions, parameters and schema names", () =>
  Promise.all([
    search("applicants"),
    search("minScore"),
    search("CandidateProfile"),
  ]).then(([byDescription, byParameter, bySchema]) => {
    assert.match(byDescription, /^GET \/jobs\/\{jobId\}\/matches/)
    assert.match(byParameter, /^GET \/jobs\/\{jobId\}\/matches/)
    assert.match(bySchema, /^POST \/candidates — Create a candidate/)
    assert.doesNotMatch(bySchema, /GET \/jobs —/)
  }))

test("answers a full sentence through nested schemas and synonyms", () =>
  search("I need to retrieve candidates who match a specific job").then(text => {
    assert.match(text, /^GET \/jobs\/\{jobId\}\/matches — Ranked matches\n\n/)
  }))

test("ranks the most specific endpoint first", () =>
  search("jobs").then(text => {
    assert.match(text, /^GET \/jobs — List jobs\nDELETE \/jobs — Delete jobs\nGET \/jobs\/\{jobId\}\/matches/)
  }))

test("says which words were unknown or only partly matched", () =>
  Promise.all([search("jobs invoices"), search("delete candidates")]).then(
    ([unknown, partial]) => {
      assert.match(
        unknown,
        /^Nothing in the spec mentions "invoices"; searched for the other words\.\nGET \/jobs — List jobs/
      )
      assert.match(
        partial,
        /^No endpoint matches every word; closest matches:\n/
      )
      assert.match(partial, /DELETE \/jobs/)
      assert.match(partial, /POST \/candidates/)
    }
  ))

test("understands other word forms and compound identifiers", () =>
  Promise.all([
    search("creating candidates"),
    search("listJobMatches"),
    search("job_id min_score"),
    search("fullName"),
  ]).then(([inflected, camelCase, snakeCase, property]) => {
    assert.match(inflected, /^POST \/candidates — Create a candidate/)
    assert.match(camelCase, /^GET \/jobs\/\{jobId\}\/matches/)
    assert.match(snakeCase, /^GET \/jobs\/\{jobId\}\/matches/)
    assert.match(property, /^POST \/candidates/m)
  }))

test("corrects a misspelled word and says so", () =>
  search("candidtes").then(text => {
    assert.match(text, /^Read "candidtes" as "candidate"\.\nPOST \/candidates/)
  }))

test("maps action words to HTTP methods", () =>
  search("remove jobs").then(text => {
    assert.match(text, /^DELETE \/jobs — Delete jobs/)
    assert.doesNotMatch(text, /GET \/jobs/)
  }))

test("shows a schema with its references and the endpoints that use it", () =>
  createStore(SPEC)
    .then(store => getSchema(store, { name: "candidateprofile" }))
    .then(result => {
      assert.equal(result.isError, false)
      assert.match(result.text, /^CandidateProfile = \{\n {2}fullName\?: string/)
      assert.match(
        result.text,
        /used directly by:\n {2}POST \/candidates — Create a candidate/
      )
      assert.match(
        result.text,
        /used through other schemas by:\n {2}GET \/jobs\/\{jobId\}\/matches/
      )
    }))

test("follows shared responses when listing the users of a schema", () =>
  createStore(SPEC)
    .then(store => getSchema(store, { name: "JobMatch" }))
    .then(result => {
      assert.match(result.text, /^JobMatch = \{/)
      assert.match(result.text, /^CandidateProfile = \{/m)
      assert.match(
        result.text,
        /used directly by:\n {2}GET \/jobs\/\{jobId\}\/matches/
      )
    }))

test("reports unused and unknown schemas", () =>
  createStore(SPEC).then(store =>
    Promise.all([
      getSchema(store, { name: "Orphan" }),
      getSchema(store, { name: "Candidate" }),
      getSchema(store, { name: "Invoice" }),
      getSchema(store, { name: "JobMatch", raw: true }),
    ]).then(([unused, close, unknown, raw]) => {
      assert.match(unused.text, /Orphan is not used by any endpoint/)
      assert.equal(close.isError, true)
      assert.match(close.text, /Closest schemas: CandidateProfile/)
      assert.match(
        unknown.text,
        /Available schemas: JobMatch, CandidateProfile, Orphan/
      )
      assert.match(raw.text, /"#\/components\/schemas\/CandidateProfile":/)
    })
  ))

test("describes how each auth scheme is sent", () =>
  createStore(SPEC).then(store =>
    Promise.all([
      getEndpoint(store, { path: "/jobs", method: "get" }),
      getEndpoint(store, { path: "/candidates" }),
    ]).then(([inherited, combined]) => {
      assert.match(inherited.text, /^auth: bearerAuth \(http bearer JWT\)$/m)
      assert.match(
        combined.text,
        /^auth: apiKey \(apiKey in header "X-API-Key"\) \+ oauth \(oauth2; scopes: write:candidates\) \| none$/m
      )
    })
  ))

test("lists response headers", () =>
  createStore(SPEC)
    .then(store => getEndpoint(store, { path: "/candidates" }))
    .then(result => {
      assert.match(
        result.text,
        /201 — created\n {4}header X-RateLimit-Remaining\?: integer — requests left\n {4}header Location: string\(uri\)/
      )
    }))

test("resolves references to other files", () =>
  writeSpecFiles({
    "spec.json": {
      openapi: "3.0.3",
      paths: {
        "/pets": {
          get: {
            responses: {
              200: {
                description: "ok",
                content: jsonContent({ $ref: "models.json#/schemas/pet" }),
              },
            },
          },
        },
        "/owners": {
          get: {
            responses: {
              200: {
                description: "ok",
                content: jsonContent({ $ref: "missing.json#/schemas/owner" }),
              },
            },
          },
        },
      },
    },
    "models.json": {
      schemas: {
        pet: {
          type: "object",
          properties: {
            tag: { $ref: "#/schemas/tag" },
            owner: { $ref: "owner.json" },
          },
        },
        tag: { type: "string", enum: ["cat", "dog"] },
      },
    },
    "owner.json": { type: "object", properties: { name: { type: "string" } } },
  }).then(store =>
    Promise.all([
      getEndpoint(store, { path: "/pets" }),
      getEndpoint(store, { path: "/owners" }),
    ]).then(([pets, owners]) => {
      assert.match(pets.text, /200 — ok: pet/)
      assert.match(pets.text, /^pet = \{\n {2}tag\?: tag\n {2}owner\?: owner\n\}/m)
      assert.match(pets.text, /^tag = "cat" \| "dog"$/m)
      assert.match(pets.text, /^owner = \{\n {2}name\?: string/m)
      assert.doesNotMatch(pets.text, /unresolved/)
      assert.match(owners.text, /owner = unknown — unresolved reference missing\.json/)
    })
  ))

const chainedSchemas = count =>
  Object.fromEntries(
    Array.from({ length: count }, (unused, index) => [
      `node${index}`,
      {
        type: "object",
        description: "x".repeat(3000),
        properties: { next: schemaReference(`node${index + 1}`) },
      },
    ])
  )

const CHAINED_SPEC = {
  openapi: "3.0.3",
  components: {
    schemas: { ...chainedSchemas(30), node30: { type: "string" } },
  },
  paths: {
    "/chain": {
      get: {
        responses: {
          200: { description: "ok", content: jsonContent(schemaReference("node0")) },
        },
      },
    },
  },
}

test("stops expanding nested schemas once the answer is large", () =>
  createStore(CHAINED_SPEC).then(store =>
    Promise.all([
      getEndpoint(store, { path: "/chain" }),
      getEndpoint(store, { path: "/chain", raw: true }),
      getSchema(store, { name: "node29" }),
    ]).then(([compact, raw, lastSchema]) => {
      assert.match(compact.text, /^node0 = \{/m)
      assert.doesNotMatch(compact.text, /^node20 = /m)
      assert.match(
        compact.text,
        /^Not expanded to keep the answer short \(read them with get_schema\): node\d+$/m
      )
      assert.ok(compact.text.length < 25000)
      assert.match(raw.text, /not expanded \(read them with get_schema\): node\d+/)
      assert.ok(raw.text.length < 50000)
      assert.match(lastSchema.text, /^node30 = string$/m)
      assert.doesNotMatch(lastSchema.text, /Not expanded/)
    })
  ))

test("stems the forms of a word to the same string", () => {
  const forms = [
    ["create", "creates", "created", "creating"],
    ["merge", "merged", "merging"],
    ["star", "starred", "starring"],
    ["repository", "repositories"],
    ["add", "adding", "added"],
    ["price", "prices", "pricing"],
  ]
  forms.forEach(([base, ...others]) =>
    others.forEach(other => assert.equal(stem(other), stem(base), other))
  )
  assert.notEqual(stem("string"), stem("str"))
  assert.equal(stem("status"), "status")
})

const manyEndpoints = count => ({
  openapi: "3.0.3",
  paths: Object.fromEntries(
    Array.from({ length: count }, (unused, index) => [
      `/invoices/kind${index}`,
      { get: { summary: `List invoices of kind ${index}`, responses: {} } },
    ])
  ),
})

test("shows the ten most relevant endpoints unless a limit is given", () =>
  createStore(manyEndpoints(25)).then(store =>
    Promise.all([
      searchEndpoints(store, { query: "invoices" }),
      searchEndpoints(store, { query: "invoices", limit: 25 }),
    ]).then(([byDefault, withLimit]) => {
      assert.equal(byDefault.text.match(/^GET /gm).length, 10)
      assert.match(
        byDefault.text,
        /^… 15 more; add words to narrow the search or pass a higher limit\.$/m
      )
      assert.equal(withLimit.text.match(/^GET /gm).length, 25)
      assert.doesNotMatch(withLimit.text, /more;/)
    })
  ))

test("leaves out endpoints that barely match", () =>
  search("delete jobs").then(text => {
    assert.match(text, /^DELETE \/jobs — Delete jobs/)
    assert.doesNotMatch(text, /POST \/candidates/)
  }))

test("does not correct a word into an unrelated one", () =>
  search("fandidates").then(text => {
    assert.match(text, /^No endpoints match "fandidates"\./)
  }))
