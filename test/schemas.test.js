import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createSpecStore } from "../src/spec.js"
import { getEndpoint, searchEndpoints } from "../src/tools.js"

const schemaReference = name => ({ $ref: `#/components/schemas/${name}` })

const jsonResponse = schema => ({
  200: { description: "ok", content: { "application/json": { schema } } },
})

const COMPLEX_SPEC = {
  openapi: "3.0.3",
  components: {
    parameters: {
      page: {
        name: "page",
        in: "query",
        deprecated: true,
        schema: { type: "integer", minimum: 1 },
      },
    },
    pathItems: {
      health: {
        get: { summary: "Health check", responses: { 200: { description: "up" } } },
      },
    },
    schemas: {
      animal: {
        description: "Base  animal",
        type: "object",
        required: ["kind"],
        properties: { kind: { type: "string" } },
      },
      dog: {
        allOf: [schemaReference("animal")],
        type: "object",
        required: ["barks"],
        properties: {
          barks: { type: "boolean" },
          size: { enum: ["small", "large"], nullable: true },
        },
      },
      cat: {
        allOf: [
          schemaReference("animal"),
          { oneOf: [schemaReference("indoor"), schemaReference("outdoor")] },
        ],
      },
      indoor: { type: "object", properties: { floor: { type: "integer" } } },
      outdoor: { type: "object", properties: { garden: { type: "string" } } },
      pet: {
        oneOf: [schemaReference("dog"), schemaReference("cat")],
        discriminator: {
          propertyName: "kind",
          mapping: { dog: "#/components/schemas/dog", cat: "#/components/schemas/cat" },
        },
        properties: { id: { type: "integer", readOnly: true } },
      },
      account: {
        type: "object",
        properties: {
          email: {
            type: "string",
            format: "email",
            minLength: 3,
            maxLength: 80,
            pattern: "^.+@.+$",
          },
          password: { type: "string", writeOnly: true },
          legacyId: { type: "integer", deprecated: true },
          role: { const: "admin" },
          score: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 10 },
          tags: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", nullable: true },
          },
          owner: { ...schemaReference("animal"), description: "who owns it" },
          address: { $ref: "shared.yaml#/components/schemas/address" },
        },
      },
    },
  },
  paths: {
    "/pets": {
      get: {
        summary: "List pets",
        parameters: [
          { $ref: "#/components/parameters/page" },
          { $ref: "shared.yaml#/components/parameters/limit" },
        ],
        responses: jsonResponse(schemaReference("pet")),
      },
    },
    "/accounts": {
      post: {
        summary: "Create an account",
        requestBody: {
          description: "the new account",
          required: true,
          content: { "application/json": { schema: schemaReference("account") } },
        },
        responses: {
          201: { $ref: "shared.yaml#/components/responses/created" },
        },
      },
    },
    "/health": { $ref: "#/components/pathItems/health" },
    "/external": { $ref: "shared.yaml#/paths/~1external" },
  },
}

const SWAGGER_2_SPEC = {
  swagger: "2.0",
  definitions: {
    pet: {
      type: "object",
      discriminator: "petType",
      required: ["petType"],
      properties: {
        petType: { type: "string" },
        nickname: { type: "string", "x-nullable": true },
      },
    },
  },
  paths: {
    "/pets": {
      get: {
        parameters: [
          {
            name: "limit",
            in: "query",
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
          },
        ],
        responses: { 200: { description: "ok", schema: { $ref: "#/definitions/pet" } } },
      },
    },
  },
}

const createStore = spec =>
  mkdtemp(path.join(os.tmpdir(), "openapi-lookup-")).then(directory => {
    const specFile = path.join(directory, "spec.json")
    return writeFile(specFile, JSON.stringify(spec)).then(() =>
      createSpecStore(specFile)
    )
  })

const render = (spec, input) =>
  createStore(spec)
    .then(store => getEndpoint(store, input))
    .then(result => result.text)

test("keeps properties declared next to allOf", () =>
  render(COMPLEX_SPEC, { path: "/pets" }).then(text => {
    assert.match(text, /^dog = animal & \{\n {2}barks: boolean/m)
  }))

test("parenthesises unions inside intersections", () =>
  render(COMPLEX_SPEC, { path: "/pets" }).then(text => {
    assert.match(text, /^cat = animal & \(indoor \| outdoor\)$/m)
    assert.match(text, /^pet = \(dog \| cat\) & \{\n {2}id\?: integer \(readOnly\)\n\}/m)
  }))

test("shows the discriminator and its mapping", () =>
  render(COMPLEX_SPEC, { path: "/pets" }).then(text => {
    assert.match(text, /\(discriminator: kind \(dog → dog, cat → cat\)\)/)
  }))

test("marks properties optional unless they are listed as required", () =>
  render(COMPLEX_SPEC, { path: "/pets" }).then(text => {
    assert.match(text, /^ {2}kind: string$/m)
    assert.match(text, /^ {2}floor\?: integer$/m)
  }))

test("does not repeat null for a nullable enum", () =>
  render(COMPLEX_SPEC, { path: "/pets" }).then(text => {
    assert.match(text, /size\?: "small" \| "large" \| null$/m)
  }))

test("describes referenced schemas with a comment", () =>
  render(COMPLEX_SPEC, { path: "/pets" }).then(text => {
    assert.match(text, /^\/\/ Base animal\nanimal = \{/m)
  }))

test("keeps constraints, access modifiers and const", () =>
  render(COMPLEX_SPEC, { path: "/accounts" }).then(text => {
    assert.match(
      text,
      /email\?: string\(email\) \(minLength: 3, maxLength: 80, pattern: \^\.\+@\.\+\$\)/
    )
    assert.match(text, /password\?: string \(writeOnly\)/)
    assert.match(text, /legacyId\?: integer \(deprecated\)/)
    assert.match(text, /role\?: "admin"/)
    assert.match(text, /score\?: number \(minimum: 0, exclusiveMinimum, maximum: 10\)/)
    assert.match(
      text,
      /tags\?: Array<string \| null> \(minItems: 1, uniqueItems\)/
    )
    assert.match(text, /owner\?: animal — who owns it/)
    assert.match(text, /^body: account — the new account$/m)
  }))

test("flags references that are not part of the spec", () =>
  Promise.all([
    render(COMPLEX_SPEC, { path: "/accounts" }),
    render(COMPLEX_SPEC, { path: "/pets" }),
    render(COMPLEX_SPEC, { path: "/external", method: "get" }),
  ]).then(([accounts, pets, external]) => {
    assert.match(
      accounts,
      /^address = unknown — unresolved reference shared\.yaml#\/components\/schemas\/address/m
    )
    assert.match(accounts, /^ {2}201: unresolved reference shared\.yaml/m)
    assert.match(pets, /^parameter: unresolved reference shared\.yaml/m)
    assert.match(pets, /page\?: integer \(deprecated, minimum: 1\)/)
    assert.match(external, /path item is an unresolved reference shared\.yaml/)
  }))

test("follows a path item reference inside the spec", () =>
  createStore(COMPLEX_SPEC).then(store =>
    Promise.all([
      getEndpoint(store, { path: "/health" }),
      searchEndpoints(store, { query: "health" }),
    ]).then(([endpoint, search]) => {
      assert.match(endpoint.text, /^GET \/health — Health check/)
      assert.match(search.text, /GET \/health — Health check/)
    })
  ))

test("supports Swagger 2 discriminator, x-nullable and parameter limits", () =>
  render(SWAGGER_2_SPEC, { path: "/pets" }).then(text => {
    assert.match(text, /limit\?: integer \(minimum: 1, maximum: 100, default: 20\)/)
    assert.match(text, /nickname\?: string \| null/)
    assert.match(text, /\(discriminator: petType\)/)
  }))
