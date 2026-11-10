import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const SERVER_NAME = "api-spec"

const readJsonConfig = file => {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, "utf8").trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      `${file} is not valid JSON. Fix or remove it, then run init again.`
    )
  }
}

const writeJsonConfig = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
}

// Writes the MCP server entry for Claude Code (.mcp.json) and Cursor
// (.cursor/mcp.json) in the given project folder. Other servers already
// configured in those files are kept.
export function initProject({ cwd, packageName, version, specUrl }) {
  if (!specUrl) {
    throw new Error(
      "Usage: openapi-lookup-mcp init <spec url or file>\n" +
        "Example: npx -y openapi-lookup-mcp init https://example.com/api-docs/swagger.yaml"
    )
  }

  const entry = {
    command: "npx",
    args: ["-y", `${packageName}@${version}`],
    env: { OPENAPI_SPEC_URL: specUrl },
  }

  const files = [
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".cursor", "mcp.json"),
  ]

  for (const file of files) {
    const config = readJsonConfig(file)
    config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: entry }
    writeJsonConfig(file, config)
  }

  return files
}
