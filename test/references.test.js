import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { downloadText } from "../src/download.js"
import { readSpec } from "../src/spec.js"
import { createSpecStore } from "../src/spec.js"
import { getEndpoint, getSchema, searchEndpoints } from "../src/tools.js"

const jsonContent = schema => ({ "application/json": { schema } })

const specReturning = reference => ({
  openapi: "3.0.3",
  paths: {
    "/pets": {
      get: {
        summary: "List pets",
        responses: {
          200: { description: "ok", content: jsonContent({ $ref: reference }) },
        },
      },
    },
  },
})

const MODELS = {
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: { toy: { $ref: "#/components/schemas/Toy" } },
      },
      Toy: { type: "object", properties: { color: { type: "string" } } },
      Spare: { type: "string" },
    },
  },
}

const servers = []

const startServer = routes =>
  new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const route = routes[request.url]
      if (!route) {
        response.writeHead(404).end()
        return
      }
      route(response, `http://127.0.0.1:${server.address().port}`)
    })
    servers.push(server)
    // Node 18 does not run a top-level after() hook, so the servers must
    // not keep the test process alive on their own.
    server.unref()
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`)
    )
  })

const sendJson = body => response => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(typeof body === "function" ? body() : body))
}

after(() =>
  servers.forEach(server => {
    server.close()
    server.closeAllConnections()
  })
)

const withEnvironment = (name, value, action) => {
  const previous = process.env[name]
  process.env[name] = value
  return Promise.resolve()
    .then(action)
    .finally(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
}

const renderPets = spec =>
  getEndpoint(
    { load: () => Promise.resolve({ spec, fetchedAt: Date.now(), label: "t" }), reloadIfStale: () => Promise.resolve(null) },
    { path: "/pets" }
  ).then(result => result.text)

test("loads referenced documents from the spec's own origin", () =>
  startServer({
    "/spec.json": sendJson(specReturning("models.json#/components/schemas/Pet")),
    "/models.json": sendJson(MODELS),
  })
    .then(origin => readSpec(`${origin}/spec.json`))
    .then(renderPets)
    .then(text => {
      assert.match(text, /^Pet = \{\n {2}toy\?: Toy/m)
      assert.match(text, /^Toy = \{/m)
      assert.doesNotMatch(text, /not loaded/)
    }))

test("does not contact other hosts unless they are allowed", () => {
  let wasContacted = false
  return startServer({
    "/models.json": response => {
      wasContacted = true
      sendJson(MODELS)(response)
    },
  }).then(otherOrigin => {
    const reference = `${otherOrigin}/models.json#/components/schemas/Pet`
    return startServer({ "/spec.json": sendJson(specReturning(reference)) }).then(
      origin =>
        readSpec(`${origin}/spec.json`)
          .then(renderPets)
          .then(text => {
            assert.equal(wasContacted, false)
            assert.match(text, /Pet = unknown — unresolved reference/)
            assert.match(
              text,
              /referenced documents not loaded: .*models\.json \(host 127\.0\.0\.1:\d+ is not allowed; add it to OPENAPI_ALLOWED_REF_HOSTS/
            )
          })
          .then(() =>
            withEnvironment(
              "OPENAPI_ALLOWED_REF_HOSTS",
              new URL(otherOrigin).host,
              () => readSpec(`${origin}/spec.json`).then(renderPets)
            )
          )
          .then(text => {
            assert.equal(wasContacted, true)
            assert.match(text, /^Pet = \{/m)
          })
    )
  })
})

test("does not follow redirects from referenced documents", () =>
  startServer({
    "/spec.json": sendJson(specReturning("moved.json#/components/schemas/Pet")),
    "/moved.json": (response, origin) => {
      response.writeHead(302, { location: `${origin}/models.json` }).end()
    },
    "/models.json": sendJson(MODELS),
  })
    .then(origin => readSpec(`${origin}/spec.json`))
    .then(renderPets)
    .then(text => {
      assert.match(text, /redirects elsewhere, which is not followed/)
      assert.match(text, /Pet = unknown/)
    }))

test("a remote spec cannot read local files", () =>
  startServer({
    "/spec.json": sendJson(specReturning("file:///etc/hosts#/Pet")),
  })
    .then(origin => readSpec(`${origin}/spec.json`))
    .then(renderPets)
    .then(text => assert.match(text, /Pet = unknown — unresolved reference file:/)))

test("gives up on slow and oversized downloads", () =>
  startServer({
    "/slow": () => {},
    "/big": response => response.end("x".repeat(5000)),
    "/stream": response => {
      response.write("x".repeat(3000))
      response.end("x".repeat(3000))
    },
  }).then(origin =>
    Promise.all([
      assert.rejects(
        downloadText(`${origin}/slow`, { maxBytes: 1000, timeoutMs: 100 }),
        /timed out after 0\.1s/
      ),
      assert.rejects(
        downloadText(`${origin}/big`, { maxBytes: 1000 }),
        /is larger than/
      ),
      assert.rejects(
        downloadText(`${origin}/stream`, { maxBytes: 1000 }),
        /is larger than/
      ),
    ])
  ))

const writeProject = files =>
  mkdtemp(path.join(os.tmpdir(), "openapi-refs-")).then(directory =>
    Promise.all(
      Object.entries(files).map(([fileName, content]) =>
        mkdir(path.dirname(path.join(directory, fileName)), {
          recursive: true,
        }).then(() =>
          writeFile(path.join(directory, fileName), JSON.stringify(content))
        )
      )
    ).then(() => directory)
  )

test("a local spec cannot read files outside its project", () =>
  writeProject({
    "api/spec.json": specReturning("../secrets/models.json#/components/schemas/Pet"),
    "secrets/models.json": MODELS,
  }).then(directory => {
    const specFile = path.join(directory, "api", "spec.json")
    return readSpec(specFile)
      .then(renderPets)
      .then(text => {
        assert.match(text, /Pet = unknown/)
        assert.match(text, /outside the project folder; set OPENAPI_REF_ROOT/)
      })
      .then(() =>
        withEnvironment("OPENAPI_REF_ROOT", directory, () =>
          readSpec(specFile).then(renderPets)
        )
      )
      .then(text => assert.match(text, /^Pet = \{/m))
  }))

test("finds schemas that live in referenced documents", () =>
  writeProject({
    "spec.json": specReturning("models.json#/components/schemas/Pet"),
    "models.json": MODELS,
  })
    .then(directory => createSpecStore(path.join(directory, "spec.json")))
    .then(store =>
      Promise.all([
        getSchema(store, { name: "Pet" }),
        getSchema(store, { name: "toy" }),
        getSchema(store, { name: "Spare" }),
        getSchema(store, { name: "Missing" }),
        searchEndpoints(store, { query: "Pet" }),
      ]).then(([pet, toy, spare, missing, search]) => {
        assert.match(pet.text, /^Pet = \{\n {2}toy\?: Toy/)
        assert.match(pet.text, /Pet is used directly by:\n {2}GET \/pets/)
        assert.match(toy.text, /Toy is used through other schemas by:\n {2}GET \/pets/)
        assert.match(spare.text, /Spare is not used by any endpoint/)
        assert.match(missing.text, /Available schemas: Pet, Toy, Spare/)
        assert.match(search.text, /^GET \/pets — List pets/)
      })
    ))
