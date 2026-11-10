# openapi-lookup-mcp

MCP server for OpenAPI and Swagger specs that lets AI coding agents read only the endpoint or schema they need instead of downloading or parsing the whole specification.

It keeps the output compact and structured, resolves `$ref` chains, and is designed for tools like Claude Code and Cursor that need fast, direct API lookups without reading a multi-megabyte YAML file.

## Why this exists

Production specs are often large: OpenAPI/Swagger documents can easily exceed 1 MB and contain hundreds of thousands of tokens. Most agents only need one route, one schema, or one specific parameter list. This tool reduces that to a small, readable summary.

Example output for a single endpoint:

```text
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
  name?: string
  members?: user[]
}
```

## Supported inputs

- OpenAPI 3.x
- Swagger 2.0
- Local files (`.yaml`, `.yml`, `.json`)
- Remote URLs
- `$ref` imports from other files and local fragments
- Schema resolution for nested objects and arrays

## Quick start

From the root of the project you want to configure:

```bash
npx -y @harborkit/openapi-lookup-mcp init https://example.com/api-docs/swagger.yaml
```

This creates or updates:

- `.mcp.json` for Claude Code
- `.cursor/mcp.json` for Cursor

It keeps any existing MCP servers already configured in those files and adds the server under the name `api-spec`.

After the config is written, open the project in the supported client and approve the new server when prompted.

## Manual configuration

If you prefer to configure the server yourself, add a block like this to `.mcp.json` (or the equivalent file for your editor):

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

The same server can also be launched directly with:

```bash
OPENAPI_SPEC_URL=https://example.com/api-docs/swagger.yaml node src/server.js
```

## Tool reference

| Tool | Input | Returns |
|---|---|---|
| `search_endpoints` | `query` | Best matches first, one line per endpoint, up to 50 results |
| `get_endpoint` | `path`, `method?`, `raw?`, `refresh?` | Compact endpoint summary with auth, params, request body, responses, and resolved schemas |
| `get_schema` | `name`, `raw?`, `refresh?` | One schema and its related schemas, plus the endpoints that use it |

### `search_endpoints`

Searches by path, method, operation id, summary, tags, description, parameter names and schema names. It ignores filler words, handles singular/plural matches, and maps action words to HTTP methods such as:

- `create` → `POST`
- `remove` → `DELETE`

Endpoints matching all keywords are listed first; otherwise the closest partial matches are returned.

### `get_endpoint`

Accepts:

- a template such as `/users/{id}`
- a concrete path such as `/users/42`
- a full URL such as `https://example.test/api/users/42?x=1`

The server removes the API base path when present before matching. `raw: true` returns the original spec YAML for that endpoint, while `refresh: true` forces a fresh fetch before answering.

### `get_schema`

Looks up a schema by name case-insensitively and suggests similar names when no exact match exists. It returns:

- the schema definition
- referenced nested schemas
- the endpoints that use the schema directly or transitively

## Reading the output

- `name?` marks an optional property or parameter; `name` without `?` is required.
- Constraints and flags appear in parentheses after the type, for example `limit?: integer (minimum: 1, default: 20) — rows per page`.
- Supported keywords include `default`, `readOnly`, `writeOnly`, `deprecated`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems` and `uniqueItems`.
- `discriminator` shows the discriminator property and its mapping, for example `discriminator: kind (dog → dog, cat → cat)`.
- `A | B` is a union, `A & B` is an intersection, and `T | null` is a nullable type.
- Unresolvable references are reported as `unresolved reference …` instead of being silently dropped.
- `auth:` shows how each scheme is sent, for example `bearerAuth (http bearer JWT)` or `apiKey (apiKey in header "X-API-Key")`.
- Response headers appear under each response as `header Name?: type`.
- Nested schemas are expanded until the answer reaches a compact size budget; remaining references are summarized as `Not expanded …` and can be read with `get_schema`.

## Caching and freshness

- Remote specs are cached for 6 hours in memory and in `~/.cache/openapi-lookup-mcp`.
- When a search or endpoint lookup returns no match, the server refreshes the spec before answering, with a cooldown of at most 5 minutes.
- Local files are re-read whenever they change.
- Referenced files are re-read only when the main spec changes.
- Every result includes the age of the spec it was read from.

## Benchmark

The project includes a benchmark script:

```bash
npm run benchmark
```

This renders every endpoint and schema for a set of public specs, fails if any render throws, and compares the compact summary against the raw YAML for the same endpoint. You can also pass your own spec URLs or local files to benchmark those instead.

| Spec | Endpoints | Schemas | Render failures | Unresolved refs | Whole spec (tokens) | Median endpoint, raw YAML | Median endpoint, compact | Compact / raw |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Petstore (Swagger 2.0) | 20 | 6 | 0 | 0 | 4,404 | 265 | 99 | 35% |
| Petstore (OpenAPI 3.0) | 19 | 6 | 0 | 0 | 5,622 | 365 | 136 | 37% |
| Stripe | 612 | 1,538 | 0 | 0 | 1,622,072 | 12,753 | 5,387 | 43% |
| GitHub REST | 1,272 | 1,011 | 0 | 0 | 2,802,448 | 1,407 | 490 | 32% |

Measured on 2026-11-10. Tokens are estimated as `characters / 4`. The `Compact / raw` ratio compares the total size of all endpoints in both formats.

## Development

```bash
npm install
npm test
npm run benchmark
node src/server.js path/to/spec.yaml
```

## Notes

- The server expects Node.js 18 or newer.
- The package name is `@harborkit/openapi-lookup-mcp`.
- The generated MCP server name is `api-spec`.
- `OPENAPI_SPEC_URL` is the environment variable used when launching the server directly.
