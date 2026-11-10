# Changelog

## 0.2.0 — unreleased

### Added

- `get_schema` tool: shows one schema by name with the schemas it references, and lists the endpoints that use it directly or through other schemas. Schemas in referenced documents are included.
- References to other files and URLs (`$ref: ./models.yaml#/pet`) are loaded and resolved.
- `search_endpoints` accepts a `limit` (default 10, up to 50).
- `init` accepts `--name <server name>` and `--force`.
- `npm run benchmark` renders every endpoint and schema of public specs and compares the compact summary with raw YAML. `npm run benchmark:search` measures search quality (Top-1, Top-5, Top-10, MRR) on 111 queries.
- CI workflow that runs the tests on Node 18, 20 and 22.

### Changed

- **Search was rewritten.** It now splits identifiers into words, matches word forms, ranks rare words and specific texts higher (BM25 over weighted fields), indexes descriptions, parameter names, schema names and body property names, understands action synonyms and abbreviations, and corrects typos. Results are ranked by how much of the query they cover, endpoints that barely match are left out, and an answer holds at most 10 endpoints by default instead of up to 50.
- **Optional properties.** A property is now shown as optional (`name?`) unless the schema lists it in `required`, as OpenAPI defines. Before, every property of a schema without a `required` list was shown as required.
- **Nested schemas are no longer expanded without limit.** Schemas an endpoint references directly are always shown; deeper ones are expanded up to about 4,000 tokens (8,000 in raw mode) and the rest are named so they can be read with `get_schema`. On the Stripe spec a single endpoint used to pull in about 190,000 tokens of schemas.
- `auth:` shows how each scheme is sent (`bearerAuth (http bearer JWT)`) and distinguishes schemes that are all required (`a + b`) from alternatives (`a | b`).
- `init` no longer replaces an `api-spec` entry that belongs to a different server; it stops and asks for `--name` or `--force`. It reports whether each file was added, updated or left unchanged.
- Downloads have a timeout and a size limit: 30 seconds and 50 MB for the spec, 15 seconds and 10 MB for each referenced document.

### Fixed

- Properties declared next to `allOf`, `oneOf` or `anyOf` were dropped.
- `discriminator`, `const`, `readOnly`, `writeOnly`, `deprecated`, numeric and length limits, `pattern` and item counts were not shown. Swagger 2 parameter limits and `x-nullable` were ignored.
- Unions inside intersections were printed without parentheses, and a nullable enum that already listed `null` printed it twice.
- Descriptions of referenced schemas, of request bodies and of properties that are a `$ref` were lost.
- Response headers were not shown.
- A parameter with a reference that could not be resolved crashed the lookup; unresolved references are now reported in the answer.
- A path item that is a `$ref` was invisible to lookup and search.

### Security

- A remote spec can only load referenced documents from its own origin, and never local files. A local spec can only read files under the folder the server runs in or the spec's own folder. Other hosts and folders need `OPENAPI_ALLOWED_REF_HOSTS` or `OPENAPI_REF_ROOT`.
- Redirects from referenced documents are not followed, and at most 50 documents are loaded, four at a time.

## 0.1.0

- First release: `search_endpoints` and `get_endpoint` over an OpenAPI 3.x or Swagger 2.0 spec, compact summary with resolved schemas, raw mode, caching of remote specs and the `init` command.
