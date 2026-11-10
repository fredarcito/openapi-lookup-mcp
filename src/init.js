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

const isOwnEntry = (entry, packageName) =>
  JSON.stringify(entry?.args || []).includes(packageName)

const describeChange = (existingEntry, entry) => {
  if (!existingEntry) return "added"
  return JSON.stringify(existingEntry) === JSON.stringify(entry)
    ? "unchanged"
    : "updated"
}

// Writes the MCP server entry for Claude Code (.mcp.json) and Cursor
// (.cursor/mcp.json) in the given project folder. Other servers already
// configured in those files are kept. An entry with the same name that
// belongs to a different server is only replaced when force is set, and
// nothing is written when any file has such a conflict.
export function initProject({
  cwd,
  packageName,
  version,
  specUrl,
  name = SERVER_NAME,
  force = false,
}) {
  if (!specUrl) {
    throw new Error(
      "Usage: openapi-lookup-mcp init <spec url or file> [--name <server name>] [--force]\n" +
        "Example: npx -y openapi-lookup-mcp init https://example.com/api-docs/swagger.yaml"
    )
  }

  const entry = {
    command: "npx",
    args: ["-y", `${packageName}@${version}`],
    env: { OPENAPI_SPEC_URL: specUrl },
  }

  const targets = [
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".cursor", "mcp.json"),
  ].map(file => {
    const config = readJsonConfig(file)
    return { file, config, existingEntry: config.mcpServers?.[name] }
  })

  const conflicts = targets.filter(
    ({ existingEntry }) =>
      existingEntry && !isOwnEntry(existingEntry, packageName)
  )
  if (conflicts.length && !force) {
    throw new Error(
      `A different server named "${name}" is already configured in ${conflicts.map(({ file }) => file).join(" and ")}.\n` +
        "Nothing was changed. Run init again with --name <other name> to keep both, or with --force to replace it."
    )
  }

  return targets.map(({ file, config, existingEntry }) => {
    writeJsonConfig(file, {
      ...config,
      mcpServers: { ...(config.mcpServers ?? {}), [name]: entry },
    })
    return { file, change: describeChange(existingEntry, entry) }
  })
}
