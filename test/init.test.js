import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { initProject } from "../src/init.js"

const SPEC = "https://example.test/api-docs/swagger.yaml"
const PACKAGE = { packageName: "openapi-lookup-mcp", version: "0.1.0" }

const newProject = () => mkdtemp(path.join(os.tmpdir(), "init-test-"))

test("creates .mcp.json and .cursor/mcp.json with a pinned entry", async () => {
  const cwd = await newProject()
  const files = initProject({ cwd, ...PACKAGE, specUrl: SPEC })

  assert.equal(files.length, 2)
  for (const file of files) {
    const config = JSON.parse(await readFile(file, "utf8"))
    assert.deepEqual(config.mcpServers["api-spec"], {
      command: "npx",
      args: ["-y", "openapi-lookup-mcp@0.1.0"],
      env: { OPENAPI_SPEC_URL: SPEC },
    })
  }
})

test("keeps servers and settings that were already configured", async () => {
  const cwd = await newProject()
  await writeFile(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: { other: { command: "other-server" } },
      extra: true,
    })
  )

  initProject({ cwd, ...PACKAGE, specUrl: SPEC })

  const config = JSON.parse(await readFile(path.join(cwd, ".mcp.json"), "utf8"))
  assert.deepEqual(config.mcpServers.other, { command: "other-server" })
  assert.ok(config.mcpServers["api-spec"])
  assert.equal(config.extra, true)
})

test("replaces an existing api-spec entry with the new URL", async () => {
  const cwd = await newProject()
  await mkdir(path.join(cwd, ".cursor"))
  await writeFile(
    path.join(cwd, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { "api-spec": { command: "old" } } })
  )

  initProject({ cwd, ...PACKAGE, specUrl: SPEC })

  const config = JSON.parse(
    await readFile(path.join(cwd, ".cursor", "mcp.json"), "utf8")
  )
  assert.equal(config.mcpServers["api-spec"].env.OPENAPI_SPEC_URL, SPEC)
})

test("fails without a spec URL and writes nothing", async () => {
  const cwd = await newProject()
  assert.throws(() => initProject({ cwd, ...PACKAGE }), /Usage: openapi-lookup-mcp init/)
  await assert.rejects(readFile(path.join(cwd, ".mcp.json")))
})

test("fails clearly when an existing config is not valid JSON", async () => {
  const cwd = await newProject()
  await writeFile(path.join(cwd, ".mcp.json"), "{ not json")
  assert.throws(() => initProject({ cwd, ...PACKAGE, specUrl: SPEC }), /not valid JSON/)
})
