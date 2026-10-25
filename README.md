<div align="center">
  <h1>@cyanheads/usitc-tariffs-mcp-server</h1>
  <p><b>Search USITC tariff schedules, inspect heading trees, and look up published duty rates via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usitc-tariffs-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usitc-tariffs-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usitc-tariffs-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/usitc-tariffs-mcp-server/releases/latest/download/usitc-tariffs-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=usitc-tariffs-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXNpdGMtdGFyaWZmcy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22usitc-tariffs-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fusitc-tariffs-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

The U.S. Harmonized Tariff Schedule from the [USITC](https://hts.usitc.gov/). Search commodity descriptions, inspect classification ancestry, read published base duty columns, and investigate partial Chapter 99 evidence. Runs as a stdio process or a local Streamable HTTP server; no upstream account or API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `usitc_search_hts` | Search descriptions and code prefixes as flat published matches |
| `usitc_get_heading` | Inspect classification ancestry, descendants, and inherited-rate sources |
| `usitc_browse_chapter` | Browse chapter headings with rate-line and statistical-line counts |
| `usitc_lookup_duty_rate` | Retrieve every published base duty column for an exact rate or statistical line |
| `usitc_check_additional_duties` | Research Chapter 99 candidates, evidence, and complete supporting passages |
| `usitc_list_reference` | Decode identifiers, program symbols, chapters, units, and edition metadata |

## Capability reference

### `usitc_search_hts` <sub>tool</sub>

- Required `query`: commodity text or a code prefix. `limit` defaults to 25, with at most 100 items per page; follow `page.nextCursor` with the same arguments.
- Returns `context: "flat_search_matches"` and rows with `ratesResolved: false`. Use heading lookup for ancestry and duty lookup for resolved base columns; no matches is a successful empty result.

---

### `usitc_get_heading` <sub>tool</sub>

- Required `code`: four, six, or eight digits, bare or conventionally dotted. Optional returned `nodeId` selects an exact node; `limit` defaults to 25, at most 100 per page.
- Returns flat source-order `nodes` with `parentId`, executable `parentFollowUp`, and `resolvedRates` states of `published`, `inherited`, or `not_published`. Unnumbered superior rows remain part of the hierarchy; a missing classification returns `found: false`.

---

### `usitc_browse_chapter` <sub>tool</sub>

- Required `chapter`: `01`–`99`, accepting one or two digits. `limit` defaults to 25, at most 100 entries per page.
- Returns complete `rateLineCount` and `statisticalLineCount` per published subtree. Chapters 98 and 99 retain their actual numbered entries; subchapter grouping is absent without a verified crosswalk, and reserved chapters can return an empty collection.

---

### `usitc_lookup_duty_rate` <sub>tool</sub>

- Required exact eight- or ten-digit `code`; optional ISO alpha-2 `countryCode`. Identifiers retain leading zeros and accept conventional dots.
- Returns General, Special, and Column 2 cells with rate-source provenance, or `found: false`. Blank statistical cells inherit only from the matching eight-digit legal ancestor; blank never means zero or `Free`.
- `specialPrograms` preserves unmatched text and `parseCoverage`; `countryAssessment` keeps membership `unknown`, eligibility and column selection `not_determined`. Country input does not select a rate or establish preference qualification.

---

### `usitc_check_additional_duties` <sub>tool</sub>

- Required exact eight- or ten-digit base commodity `code`, excluding Chapter 99; optional `countryCode`. `view` is `candidates` (default), `evidence` (requires returned `candidateCode`), or `unmapped`. `limit` defaults to 25, at most 100 per page.
- `coverage.status` is always `partial`; inspect `supportedGrammar`, `limitations`, and unresolved evidence. Candidate `legalStatus` is `not_determined`. Unknown and different-country evidence remains visible; an empty candidate list never establishes clearance.
- Follow returned `nextCall` and evidence `followUp` objects. For passages, supply `noteId` and optional `noteCursor` with the original code/country selectors, omitting `view`, `candidateCode`, and collection `cursor`; concatenate all `notesPage.fragments` across pages and inspect governing context.

---

### `usitc_list_reference` <sub>tool</sub>

- Required `topic`: `identifiers`, `spi`, `chapters`, `units`, or `releases`. `limit` defaults to 25, at most 100 entries per page.
- Program and unit decoders carry their verification edition and citations. SPI country membership remains unknown; release records describe published editions without enabling historical tariff lookup.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

USITC-specific:

- Keyless access to the HTS application's undocumented interfaces, with paced requests and bounded retries.
- Published descriptions, rate strings, units, sparse fields, and footnotes preserved alongside legal ancestry.
- Edition-pinned Special Program Indicator decoding and partial Chapter 99 evidence research.
- No conclusive classification, preference qualification, duty stacking, combined-duty calculation, or current-enforceability determination. Confirm legal applicability against legal notes and current CBP/Federal Register guidance.

Agent-friendly output:

- Provenance — every result carries `release`, `source`, and `notices`; edition checks prevent detected cross-edition mixing, but do not prove atomic publication or current law.
- Complete continuation — pages expose `total`, `returned`, `effectiveLimit`, and `nextCursor`; a 24,000-byte complete-reply budget can reduce page size with `budgetLimited: true`. Cursors bind the original arguments and source snapshot, expire within 15 minutes, and can expire earlier after eviction or restart.
- Explicit uncertainty — `found`, rate states, partial coverage, and typed error reasons support branching without guessing. Restart the original call without cursors after `cursor_expired`; fix selectors after `invalid_cursor` or `invalid_selector`.
- Matching response surfaces — `content[]` and `structuredContent` carry the same selected data; published source text is framed as data rather than instructions.

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "usitc-tariffs-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/usitc-tariffs-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio", "MCP_LOG_LEVEL": "info" }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "usitc-tariffs-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/usitc-tariffs-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio", "MCP_LOG_LEVEL": "info" }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "usitc-tariffs-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/usitc-tariffs-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the built server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+ for the published package).
- Network access to `hts.usitc.gov`.

### Installation

```sh
git clone https://github.com/cyanheads/usitc-tariffs-mcp-server.git
cd usitc-tariffs-mcp-server
bun install
cp .env.example .env
bun run rebuild
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Framework storage backend. Domain snapshots remain in process. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

No server-specific environment variables are required. See [`.env.example`](./.env.example) for common framework overrides.

## Running the server

### Local development

```sh
bun run rebuild
bun run start:http
# or
bun run start:stdio
```

Run checks and tests:

```sh
bun run devcheck
bun run test
```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/usitc-tariffs-mcp-server:latest
```

The image serves HTTP on port 3010; configure authentication before exposing it publicly.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/` | Six definitions, shared output schemas, and lossless response formatting |
| `src/services/usitc/` | Fixed-origin HTTP client, edition checks, pacing, and derived snapshots |
| `src/services/tariffs/` | Hierarchy, base-rate resolution, and argument-bound pagination |
| `src/services/reference/` | Identifier validation and edition-pinned reference decoders |
| `src/services/chapter99/` | Partial evidence indexing, selectors, and passage fragments |
| `tests/` | Tests and public-source fixtures mirroring `src/` |
| `docs/` | [Design contracts](./docs/design.md) and [directory tree](./docs/tree.md) |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic.
- Use `ctx.log` for logging and propagate `ctx.signal` to upstream work.
- Register tools in the `createApp()` array in `src/index.ts`.
- Validate raw responses, preserve missing values, and keep both output surfaces identical.
- Preserve partial-coverage and country-qualification limits when extending the evidence grammar.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
