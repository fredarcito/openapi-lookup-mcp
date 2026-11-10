# openapi-lookup-mcp

An MCP server that lets AI coding agents look up **one endpoint at a time** from an OpenAPI/Swagger spec, as a compact summary, instead of downloading or reading the whole spec.

The only configuration is the location of the spec.

## Why

A real-world spec is easily 1 MB of YAML — hundreds of thousands of tokens. Agents usually need one endpoint. This server returns just that endpoint in a TypeScript-like notation that is roughly a third of the size of the original YAML, with every referenced schema resolved in the same answer:

```
GET /users/{id} — Get a user
auth: bearerAuth
path:
  id: string
query:
  view?: "short" | "full" — level of detail
responses:
  200 — success: user
  404 — not found

user = {
  id: integer
  nickname?: string | null
  team?: team
}

team = {
  name: string
  members: user[]
}
```

## Setup

Run this in the root of your project:

```bash
npx -y @harborkit/openapi-lookup-mcp init https://example.com/api-docs/swagger.yaml
```

It writes the server into `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor), keeping any other servers already configured there. Commit those files so the team gets the same setup. Then open the project and approve the `api-spec` server when Claude Code asks.

The spec can be a URL or a local file (for example `./docs/swagger.yaml`), in YAML or JSON, OpenAPI 3.x or Swagger 2.0. Each project has its own spec, so run `init` with that project's URL.

Manual configuration, if you prefer it: put this in `.mcp.json` and set the URL in `env`:

```json
{
  "mcpServers": {
    "api-spec": {
      "command": "npx",
      "args": ["-y", "@harborkit/openapi-lookup-mcp@0.1.0"],
      "env": {
        "OPENAPI_SPEC_URL": "https://example.com/api-docs/swagger.yaml"
      }
    }
  }
}
```

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_endpoints` | `query` | One line per endpoint whose path, method, summary, tag or operation id contains every word (up to 50) |
| `get_endpoint` | `path`, optional `method`, `raw`, `refresh` | Auth, parameters, request body and responses of the endpoint, plus the schemas it references |

`get_endpoint` accepts a template (`/users/{id}`), a concrete path (`/users/42`) or a full URL; the server base path is stripped when present. `raw: true` returns the original YAML of the endpoint and `refresh: true` downloads the spec again first.

## Staying up to date

- A remote spec is cached for 6 hours (in memory and in `~/.cache/openapi-lookup-mcp`).
- When an endpoint or a search has no match, the spec is downloaded again before answering, at most once every 5 minutes, so newly added endpoints are found without any action.
- A local file is re-read whenever it changes.
- Every answer ends with the age of the spec it was read from.

## Development

```bash
npm install
npm test
node src/server.js path/to/spec.yaml
```
