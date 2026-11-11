# openapi-lookup-mcp

MCP server that lets AI coding agents such as Claude Code and Cursor read one endpoint or schema of an OpenAPI or Swagger spec instead of the whole file. Real-world specs often run to millions of tokens and do not fit in a context window; with this server the agent searches the spec, gets back a compact summary with every `$ref` already resolved, and keeps working.

- **Over 99% fewer tokens than reading the spec:** finding and reading one endpoint costs about 2,000 tokens on the 2.8-million-token GitHub spec.
- **57–68% smaller than the same endpoint in YAML**, with nested schemas resolved in a single call.
- **Built-in search** that handles typos, word forms and identifiers such as `listJobMatches`, with no model or embeddings.
- **Local files or remote URLs**, OpenAPI 3.x and Swagger 2.0, with caching and automatic refresh.

## Installation

Requires Node.js 18 or newer. From the root of your project:

```bash
npx -y @harborkit/openapi-lookup-mcp init https://example.com/api-docs/swagger.yaml
```

Then open the project in Claude Code or Cursor and approve the new `api-spec` server when prompted.

The command writes `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor), keeping any servers already configured there. Running it again updates the entry, for example with a new URL. If a different server is already registered as `api-spec`, nothing is changed: add `--name <other name>` to keep both, or `--force` to replace it.

```bash
npx -y @harborkit/openapi-lookup-mcp init https://example.com/api-docs/swagger.yaml --name billing-api
```

### Manual configuration

If you prefer to configure the server yourself, add a block like this to `.mcp.json` (or the equivalent file for your editor):

```json
{
  "mcpServers": {
    "api-spec": {
      "command": "npx",
      "args": ["-y", "@harborkit/openapi-lookup-mcp@0.2.0"],
      "env": {
        "OPENAPI_SPEC_URL": "https://example.com/api-docs/swagger.yaml"
      }
    }
  }
}
```

The same server can also be launched directly, with the spec as an argument or in `OPENAPI_SPEC_URL`:

```bash
npx -y @harborkit/openapi-lookup-mcp https://example.com/api-docs/swagger.yaml
```

#### Environment variables

| Variable | Purpose |
|---|---|
| `OPENAPI_SPEC_URL` | URL or file path of the spec, when it is not given as an argument |
| `OPENAPI_ALLOWED_REF_HOSTS` | Extra hosts that referenced documents may be loaded from (comma-separated, or `*` for any); see [Referenced documents](#referenced-documents) |
| `OPENAPI_REF_ROOT` | Folder that a local spec may read referenced files from, instead of the folder the server runs in |
| `XDG_CACHE_HOME` | Where the cache of remote specs is kept; defaults to `~/.cache` |

## Example

```text
GET /users/{id} — Get a user
auth: bearerAuth (http bearer JWT)
path:
  id: string
query:
  view?: "short" | "full" (default: "short") — level of detail
responses:
  200 — success: user
    header X-RateLimit-Remaining?: integer
  404 — not found

user = {
  id: integer (readOnly)
  nickname?: string | null (maxLength: 30)
  team?: team
}

team = {
  name: string
  members?: user[]
}

spec read just now from spec.yaml
```

See [Token cost](#token-cost) for how this compares to reading the spec.

## Token cost

Measured on the GitHub REST and Stripe specs with the 111 queries of the search benchmark. Tokens are estimated as `characters / 4`; no agent was involved, so the agent's own reasoning is not counted.

| | GitHub REST | Stripe |
|---|---:|---:|
| Whole spec | 2,802,448 | 1,622,072 |
| Tool definitions and instructions, once per session | ~820 | ~820 |
| One search (median) | ~220 | ~180 |
| Reading the endpoint that was found (median) | ~1,650 | ~6,340 |
| **Search and read one endpoint (median)** | **~1,900** | **~6,550** |

Without the tool, an agent has three options, all worse on a large spec:

- **Read the whole spec.** Neither of these specs fits in a context window.
- **Grep a local file and read pieces of YAML.** The same endpoint with its schemas is about three times larger in YAML than in the compact summary, and following each `$ref` by hand takes several turns.
- **Fetch a remote spec.** A URL cannot be grepped, so the agent downloads everything or works from a lossy summary.

The queries above target popular, large endpoints. Across every endpoint of the GitHub spec the median summary is about 490 tokens.

When it does not pay off: on a small spec such as Petstore (about 5,000 tokens in full), reading the file once is affordable. The tool still wins for a handful of lookups, but an agent that needs most of the endpoints spends about the same either way.

## Supported inputs

- OpenAPI 3.x
- Swagger 2.0
- Local files (`.yaml`, `.yml`, `.json`)
- Remote URLs
- `$ref` imports from other files and local fragments, within the limits in [Referenced documents](#referenced-documents)
- Schema resolution for nested objects and arrays

## Tool reference

| Tool | Input | Returns |
|---|---|---|
| `search_endpoints` | `query`, `limit?` | The 10 most relevant endpoints, one line each; understands word forms, identifiers and typos |
| `get_endpoint` | `path`, `method?`, `raw?`, `refresh?` | Compact endpoint summary with auth, params, request body, responses, and resolved schemas |
| `get_schema` | `name`, `raw?`, `refresh?` | One schema and its related schemas, plus the endpoints that use it |

### `search_endpoints`

Ranked keyword search over every endpoint of the spec. It needs no model, embeddings or extra dependency: the index is built in memory the first time the spec is searched (about 0.2 s for the GitHub spec) and a query takes a few milliseconds.

What is searched, from most to least important:

- path, summary and operation id
- HTTP method, tags, parameter names and the schemas the endpoint uses
- description, and the property names of its request and response bodies
- schemas nested one level deeper, path parameters and parameter descriptions

How a query is read:

- **Filler words** such as `I`, `need`, `how` or `the` are ignored.
- **Word forms** match each other: `create`, `creates`, `created` and `creating`; `repository` and `repositories`.
- **Identifiers** are split into their words, so `listJobMatches`, `job_matches` and `job matches` are the same query.
- **Action words** match the HTTP method and their synonyms: `retrieve` or `show` → `GET`, `add` or `new` → `POST`/`create`, `edit` or `modify` → `PATCH`/`PUT`/`update`, `remove` → `DELETE`.
- **Abbreviations** match the words they start: `repo` finds `repository`.
- **Typos** are corrected when a word is not in the spec at all, and the answer says so. Only words of five letters or more are corrected, and never by changing the first letter.

How results are ranked:

- A word that is rare in the spec counts for more than one that appears in most endpoints.
- A match in a short, specific text counts for more than one in a long text, so `create issue` ranks `POST …/issues` above `POST …/issues/{issue_number}/assignees`.
- An endpoint that misses a word of the query is ranked lower, and more so when the missing word is a rare one. When not even the best result has every word, the answer starts with a line that says so.
- Endpoints that score far below the best one are left out, so a precise query gets a short answer.
- At most 10 endpoints are returned, about 200 tokens. When more are relevant the answer ends with `… N more`; pass `limit` (up to 50) to list everything about a resource.

```text
> search_endpoints { "query": "create teams" }

POST /teams — Create a team

> search_endpoints { "query": "creating a tema" }

Read "tema" as "team".
POST /teams — Create a team

> search_endpoints { "query": "nickname invoices" }

Nothing in the spec mentions "invoices"; searched for the other words.
GET /users/{id} — Get a user
POST /teams — Create a team
```

Keywords still work better than long sentences, and the search matches words, not meanings: it does not know that "bookmark" means "star". The tool description tells the agent to search again with the API's own terms when the endpoint it needs is not listed; with short answers, a second search costs less than one long answer. See [Search quality](#search-quality) for measurements.

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

Schemas that live in referenced documents can be looked up the same way. `raw` and `refresh` behave as in `get_endpoint`.

```text
> get_schema { "name": "team" }

team = {
  name: string
  members?: user[]
}

user = {
  id: integer (readOnly)
  nickname?: string | null (maxLength: 30)
  team?: team
}

team is used directly by:
  POST /teams — Create a team
used through other schemas by:
  GET /users/{id} — Get a user
```

## Reading the output

- `name?` marks an optional property or parameter; `name` without `?` is required. As in OpenAPI, a property is optional unless the schema lists it in `required`.
- Constraints and flags appear in parentheses after the type, for example `limit?: integer (minimum: 1, default: 20) — rows per page`.
- Supported keywords include `default`, `readOnly`, `writeOnly`, `deprecated`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems` and `uniqueItems`. Examples are not shown; use `raw: true` to see them.
- A line starting with `//` above a schema is that schema's description.
- `discriminator` shows the discriminator property and its mapping, for example `discriminator: kind (dog → dog, cat → cat)`.
- `A | B` is a union, `A & B` is an intersection, and `T | null` is a nullable type.
- Unresolvable references are reported as `unresolved reference …` instead of being silently dropped.
- `auth:` shows how each scheme is sent, for example `bearerAuth (http bearer JWT)` or `apiKey (apiKey in header "X-API-Key")`. `a + b` means both are required, `a | b` means either one, and `none` means the endpoint can be called without credentials.
- Response headers appear under each response as `header Name?: type`.
- Schemas the endpoint references directly are always shown. Schemas nested inside them are expanded until they add up to about 4,000 tokens; the rest are named in a `Not expanded …` line and can be read with `get_schema`.
- Every answer ends with the age and source of the spec, and with a warning when a referenced document could not be loaded.

## Referenced documents

A spec decides which other documents get loaded, so those references are restricted by default:

- A remote spec can only load documents from its own origin (same scheme, host and port). To allow other hosts, list them in `OPENAPI_ALLOWED_REF_HOSTS` (comma-separated, or `*` for any). A remote spec can never read local files.
- A local spec can only load files inside the folder the server runs in or the spec's own folder, after resolving symlinks. Set `OPENAPI_REF_ROOT` to allow a different folder. Remote documents also need `OPENAPI_ALLOWED_REF_HOSTS`.
- Referenced documents are limited to 10 MB each, 15 seconds per download and 50 documents in total. They are read four at a time and redirects are not followed.
- The spec itself is limited to 50 MB and 30 seconds.

A document that is not loaded does not stop the server. Its references are shown as `unresolved reference …` and every answer ends with the reason, for example `referenced documents not loaded: https://other.test/models.yaml (host other.test is not allowed; …)`.

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

### Search quality

```bash
npm run benchmark:search            # add "-- --misses" to list the queries that fail
```

This runs the 111 queries in `scripts/search-queries.js` against the GitHub and Stripe specs. Each query names the endpoint an agent would want back. The report gives, per query type, how often that endpoint is among the first 1, 5 and 10 results (Top-1, Top-5, Top-10), the mean reciprocal rank (MRR, the mean of 1 / rank) and the mean number of endpoints in an answer.

| Query type | Example | Queries | Top-1 | Top-5 | Top-10 | MRR | Results shown |
|---|---|---:|---:|---:|---:|---:|---:|
| keyword | `merge pull request` | 18 | 78% | 100% | 100% | 0.87 | 9.3 |
| sentence | `how do I add a comment to an issue` | 14 | 36% | 71% | 86% | 0.49 | 9.6 |
| paraphrase | `remove a member's access to a repo` | 37 | 32% | 46% | 57% | 0.39 | 9.5 |
| inflection | `merging pull requests` | 11 | 64% | 91% | 100% | 0.75 | 10.0 |
| compound | `createPullRequestReview` | 11 | 64% | 100% | 100% | 0.78 | 9.5 |
| field | `release tag_name prerelease` | 10 | 40% | 90% | 100% | 0.59 | 9.4 |
| typo | `merge pul request` | 10 | 80% | 100% | 100% | 0.90 | 9.2 |
| **all** | | 111 | 51% | 77% | 84% | 0.62 | 9.5 |

Measured on 2026-11-10 with version 0.2.0. A search answer is about 220 tokens on the GitHub spec and 180 on Stripe (median).

Paraphrases remain the weak spot: a query whose words are not in the spec ("bookmark a repository", "tag an issue" for labels, "reverse a payment" for refunds) cannot be found by matching words. The query set is hand-written and was also used to tune the ranking, so these figures are optimistic; one query moves a row by 3 to 10 points.

## Limitations

- **Search matches words, not meanings.** A query with none of the API's own terms ("bookmark" for star, "chargeback" for dispute) will not find the endpoint; the agent has to search again.
- **Search understands English only.** Filler words, word forms and action synonyms are English.
- **Large schema graphs are cut.** Nested schemas beyond about 4,000 tokens are named, not expanded, so reading a deeply linked model can take several `get_schema` calls.
- **Examples are not shown** in the compact summary; `raw: true` returns them.
- **Constraints of array items** (for example the `minLength` of each element) are not shown; only those of the array itself are.
- **Referenced documents behind a redirect are not loaded**, and a referenced file that changes is only re-read when the main spec changes.
- **Not covered:** callbacks, links, webhooks and the `style`/`explode` serialization of parameters.

## Development

```bash
npm install
npm test
npm run benchmark
npm run benchmark:search
node src/server.js path/to/spec.yaml
```

Source layout:

| File | Responsibility |
|---|---|
| `src/server.js` | Command line, `init` command and MCP tool registration |
| `src/tools.js` | The three tools: lookup, error messages and answer text |
| `src/spec.js` | Loading, caching and refreshing the spec |
| `src/bundle.js` | Loading referenced documents and the rules for what may be loaded |
| `src/download.js` | HTTP download with timeout and size limit |
| `src/render.js` | Compact TypeScript-like and raw YAML rendering |
| `src/lookup.js` | Matching a requested path to a path of the spec |
| `src/search.js` | Search index, stemming and ranking |
| `src/schemas.js` | Schema index and which endpoints use each schema |
| `src/init.js` | Writing the MCP configuration files |
| `scripts/` | Benchmarks; not part of the published package |

Tests use Node's built-in runner and need no network, except `test/references.test.js`, which starts local HTTP servers. The benchmarks download public specs. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Notes

- The server expects Node.js 18 or newer.
- The package name is `@harborkit/openapi-lookup-mcp`.
- The generated MCP server name is `api-spec` unless `--name` is given.
- `OPENAPI_SPEC_URL` is the environment variable used when launching the server directly.
