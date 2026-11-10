import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { stringify } from "yaml"
import { createSpecStore } from "../src/spec.js"
import { getEndpoint, searchEndpoints } from "../src/tools.js"

const OPENAPI_3_SPEC = {
  openapi: "3.0.1",
  servers: [{ url: "https://example.test/api" }],
  components: {
    schemas: {
      user: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "integer" },
          nickname: { type: "string", nullable: true },
          team: { $ref: "#/components/schemas/team" },
        },
      },
      team: {
        type: "object",
        properties: {
          name: { type: "string" },
          members: {
            type: "array",
            items: { $ref: "#/components/schemas/user" },
          },
        },
      },
    },
  },
  paths: {
    "/users/{id}": {
      get: {
        summary: "Get a user",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "view",
            in: "query",
            description: "level of detail",
            schema: { type: "string", enum: ["short", "full"] },
          },
        ],
        responses: {
          200: {
            description: "success",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/user" },
              },
            },
          },
          404: { description: "not found" },
        },
      },
      delete: {
        summary: "Delete a user",
        tags: ["users"],
        responses: { 204: { description: "deleted" } },
      },
    },
    "/users/me": {
      get: {
        summary: "Get the current user",
        tags: ["users"],
        responses: { 200: { description: "success" } },
      },
    },
    "/teams": {
      post: {
        summary: "Create a team",
        tags: ["teams"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  size: { type: "integer", default: 5 },
                },
              },
            },
          },
        },
        responses: { 201: { description: "created" } },
      },
    },
  },
}

const SWAGGER_2_SPEC = {
  swagger: "2.0",
  basePath: "/v2",
  definitions: {
    pet: { type: "object", properties: { name: { type: "string" } } },
  },
  paths: {
    "/pets": {
      post: {
        summary: "Add a pet",
        parameters: [
          {
            name: "pet",
            in: "body",
            required: true,
            schema: { $ref: "#/definitions/pet" },
          },
          { name: "limit", in: "query", type: "integer" },
        ],
        responses: {
          200: {
            description: "ok",
            schema: { type: "array", items: { $ref: "#/definitions/pet" } },
          },
        },
      },
    },
  },
}

const createStore = (spec, fileName) =>
  mkdtemp(path.join(os.tmpdir(), "openapi-lookup-")).then(directory => {
    const specFile = path.join(directory, fileName)
    const specText = fileName.endsWith(".json")
      ? JSON.stringify(spec)
      : stringify(spec)
    return writeFile(specFile, specText).then(() => createSpecStore(specFile))
  })

test("summarises an endpoint and resolves referenced schemas once", () =>
  createStore(OPENAPI_3_SPEC, "spec.yaml")
    .then(store => getEndpoint(store, { path: "/users/{id}", method: "GET" }))
    .then(result => {
      assert.equal(result.isError, false)
      assert.match(result.text, /^GET \/users\/\{id\} — Get a user/)
      assert.match(result.text, /auth: bearerAuth/)
      assert.match(result.text, /path:\n {2}id: string/)
      assert.match(result.text, /view\?: "short" \| "full" — level of detail/)
      assert.match(result.text, /200 — success: user/)
      assert.match(result.text, /nickname\?: string \| null/)
      assert.match(result.text, /members: user\[\]/)
      assert.equal(result.text.match(/^user = /gm).length, 1)
      assert.equal(result.text.match(/^team = /gm).length, 1)
      assert.doesNotMatch(result.text, /DELETE/)
    }))

test("prefers an exact path over a template and accepts full URLs", () =>
  createStore(OPENAPI_3_SPEC, "spec.yaml").then(store =>
    Promise.all([
      getEndpoint(store, { path: "/users/me" }),
      getEndpoint(store, { path: "https://example.test/api/users/42?x=1" }),
    ]).then(([exactResult, concreteResult]) => {
      assert.match(exactResult.text, /^GET \/users\/me/)
      assert.match(concreteResult.text, /^GET \/users\/\{id\}/)
      assert.match(concreteResult.text, /DELETE \/users\/\{id\}/)
    })
  ))

test("renders request bodies with optional fields and defaults", () =>
  createStore(OPENAPI_3_SPEC, "spec.json")
    .then(store => getEndpoint(store, { path: "/teams" }))
    .then(result => {
      assert.match(result.text, /body: \{\n {2}name: string/)
      assert.match(result.text, /size\?: integer \(default: 5\)/)
    }))

test("reports unknown paths and methods as errors with hints", () =>
  createStore(OPENAPI_3_SPEC, "spec.yaml").then(store =>
    Promise.all([
      getEndpoint(store, { path: "/users/1/unknown" }),
      getEndpoint(store, { path: "/teams", method: "get" }),
    ]).then(([missingPath, missingMethod]) => {
      assert.equal(missingPath.isError, true)
      assert.match(missingPath.text, /No endpoint matches/)
      assert.match(missingPath.text, /GET \/users\/\{id\}/)
      assert.equal(missingMethod.isError, true)
      assert.match(missingMethod.text, /has no GET; available: POST/)
    })
  ))

test("returns the original YAML with referenced schemas in raw mode", () =>
  createStore(OPENAPI_3_SPEC, "spec.yaml")
    .then(store =>
      getEndpoint(store, { path: "/users/{id}", method: "get", raw: true })
    )
    .then(result => {
      assert.match(result.text, /summary: Get a user/)
      assert.match(result.text, /"#\/components\/schemas\/team":/)
      assert.doesNotMatch(result.text, /Delete a user/)
    }))

test("searches by every term across path, summary and tags", () =>
  createStore(OPENAPI_3_SPEC, "spec.yaml").then(store =>
    Promise.all([
      searchEndpoints(store, { query: "users get" }),
      searchEndpoints(store, { query: "nothing" }),
    ]).then(([matches, noMatches]) => {
      assert.match(matches.text, /GET \/users\/\{id\} — Get a user/)
      assert.match(matches.text, /GET \/users\/me/)
      assert.doesNotMatch(matches.text, /DELETE/)
      assert.match(noMatches.text, /No endpoints match "nothing"/)
    })
  ))

test("supports Swagger 2 parameters, responses and base path", () =>
  createStore(SWAGGER_2_SPEC, "spec.json")
    .then(store => getEndpoint(store, { path: "/v2/pets" }))
    .then(result => {
      assert.match(result.text, /body:\n {2}pet: pet/)
      assert.match(result.text, /limit\?: integer/)
      assert.match(result.text, /200 — ok: pet\[\]/)
      assert.match(result.text, /^pet = \{\n {2}name: string/m)
    }))

test("rejects documents that are not a spec", () =>
  createStore({ hello: "world" }, "spec.json").then(store =>
    assert.rejects(getEndpoint(store, { path: "/x" }), /not an OpenAPI/)
  ))
