#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createSpecStore } from "./spec.js"
import { getEndpoint, getSchema, searchEndpoints } from "./tools.js"
import { SERVER_NAME, initProject } from "./init.js"

const USAGE = `Usage: openapi-lookup-mcp <spec url or file>
       openapi-lookup-mcp init <spec url or file> [--name <server name>] [--force]

The spec location can also be given in the OPENAPI_SPEC_URL environment variable.`

const INSTRUCTIONS =
  "Looks up endpoints of this project's backend API from its OpenAPI/Swagger spec. Before writing or changing code that calls the API, use get_endpoint to read the exact params, body and responses, search_endpoints when the path is not known, and get_schema to read one data model or find the endpoints that use it. Do not download or read the spec file directly."

const packageInfo = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
)

const toToolResult = result => ({
  content: [{ type: "text", text: result.text }],
  isError: result.isError,
})

const toToolError = error => ({
  content: [{ type: "text", text: error.message }],
  isError: true,
})

if (process.argv[2] === "init") {
  try {
    const initArguments = process.argv.slice(3)
    const nameIndex = initArguments.indexOf("--name")
    const name = nameIndex === -1 ? SERVER_NAME : initArguments[nameIndex + 1]
    if (!name || name.startsWith("--")) {
      throw new Error("--name needs a server name, e.g. --name billing-api")
    }
    const specUrl = initArguments.find(
      (argument, index) =>
        !argument.startsWith("--") &&
        (nameIndex === -1 || index !== nameIndex + 1)
    )
    const files = initProject({
      cwd: process.cwd(),
      packageName: packageInfo.name,
      version: packageInfo.version,
      specUrl,
      name,
      force: initArguments.includes("--force"),
    })
    console.log(
      `Configured ${name} in:\n${files.map(({ file, change }) => `  ${file} (${change})`).join("\n")}`
    )
    console.log("Open the project in Claude Code or Cursor and approve the server when asked.")
    process.exit(0)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

const source = process.argv[2] || process.env.OPENAPI_SPEC_URL

if (!source) {
  console.error(USAGE)
  process.exit(1)
}

const store = createSpecStore(source)
const server = new McpServer(
  { name: packageInfo.name, version: packageInfo.version },
  { instructions: INSTRUCTIONS }
)

server.registerTool(
  "search_endpoints",
  {
    title: "Search API endpoints",
    description:
      "Find API endpoints by keywords, best match first. Looks in the path, method, operation id, summary, tags, description, parameter names, schema names and the property names of request and response bodies. Word forms, camelCase or snake_case identifiers and small typos are understood. Returns one line per endpoint, the 10 most relevant by default. The search matches words, not meanings: if the endpoint you need is not listed, search again with the terms this API uses (the results show its vocabulary) or with a synonym.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe(
          'Keywords rather than a sentence, e.g. "jobs", "create company photo" or "listJobMatches"'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Maximum number of endpoints to return (default 10); raise it to list everything about a resource"
        ),
    },
    annotations: { readOnlyHint: true },
  },
  input => searchEndpoints(store, input).then(toToolResult).catch(toToolError)
)

server.registerTool(
  "get_endpoint",
  {
    title: "Get API endpoint details",
    description:
      "Show the auth, parameters, request body and responses of one API endpoint as a compact summary with referenced schemas resolved. The path may be a template (/users/{id}), a concrete path (/users/42) or a full URL.",
    inputSchema: {
      path: z.string().min(1).describe("Endpoint path, e.g. /users/{id}"),
      method: z
        .string()
        .optional()
        .describe("HTTP method; omit to show every method of the path"),
      raw: z
        .boolean()
        .optional()
        .describe(
          "Return the original spec YAML instead of the summary; use only when the summary lacks a detail"
        ),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Download the spec again first; use when the result does not match the API's real behaviour"
        ),
    },
    annotations: { readOnlyHint: true },
  },
  input => getEndpoint(store, input).then(toToolResult).catch(toToolError)
)

server.registerTool(
  "get_schema",
  {
    title: "Get API schema details",
    description:
      "Show one schema (data model) of the API by name as a compact summary with the schemas it references, followed by the endpoints that use it. Use it to read a model without going through an endpoint, or to find which endpoints accept or return it.",
    inputSchema: {
      name: z.string().min(1).describe("Schema name, e.g. CandidateProfile"),
      raw: z
        .boolean()
        .optional()
        .describe(
          "Return the original spec YAML instead of the summary; use only when the summary lacks a detail"
        ),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Download the spec again first; use when the result does not match the API's real behaviour"
        ),
    },
    annotations: { readOnlyHint: true },
  },
  input => getSchema(store, input).then(toToolResult).catch(toToolError)
)

server.connect(new StdioServerTransport()).catch(error => {
  console.error(error.message)
  process.exit(1)
})
