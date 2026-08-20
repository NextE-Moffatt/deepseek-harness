# @deepseek-ai/dsh-kb-mcp-server

English | [中文](README.zh.md)

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server exposing the knowledge-base reference pool over stdio: `search_cards` / `read_card` / `freshness_review` / `heat`, every handler a pure read through `ctx.kb`. The write side stays inside the harness (the `kb_*` tools and the web workbench), where `kb/*` events are logged. The [milestone-5 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) owns the scope decisions.

## Usage

The `dsh-kb-mcp` bin boots the minimal composition (system-prompt / tools / kb-core / this server) and serves the workspace's reference pool until the client disconnects. Point any MCP client at it:

```sh
KB_MCP_ROOT=/path/to/workspace dsh-kb-mcp
```

For an MCP client that spawns stdio servers (for example another DSH instance's `mcp-client` row), pass the same environment:

```yaml
- id: kb-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: kb
    transport: stdio
    command: dsh-kb-mcp
    env:
      KB_MCP_ROOT: !!js process.env.KB_MCP_ROOT
```

## Configuration

The bin reads deployment configuration from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `KB_MCP_ROOT` | — | The workspace root whose reference pool this server exposes (required, absolute). |
| `KB_MCP_CARDS_PATH` | `kb/cards` | Library path relative to the root. |
| `KB_MCP_INDEX_PATH` | `kb/.kb-index.sqlite` | FTS5 index database path relative to the root. |
| `KB_MCP_HEAT_PATH` | `kb/.kb-heat.jsonl` | Heat ledger path relative to the root. |
| `KB_MCP_RECAP_PATH` | `kb/.kb-recap.jsonl` | Recap checkpoint path relative to the root. |
| `KB_MCP_TEAM_REPO_PATH` | — | Team library git work tree (absolute, or relative to the root). |
| `KB_MCP_CARD_TTL_DAYS` | `90` | Default 有效期 horizon in days. |
| `KB_MCP_FRESHNESS_WARNING_DAYS` | `14` | The expiring-soon window in days. |

As a Cordis plugin, the package also exposes `Config` (`{ root: string }`) and `apply`, so a composition can mount it directly. Invalid values fail loud at load.

## Tools

All four tools are read-only; each returns a human-readable text block plus `structuredContent` with the exact `dsh-kb-core` payload.

| Tool | Arguments | Result |
|---|---|---|
| `search_cards` | `query` (required), `type` / `status` / `tier` / `tags` filters, `limit` (1–50, default 10) | `SearchOutcome`: FTS5 BM25 hits, or the explicit `mode: 'scan'` degradation with its note. |
| `read_card` | `id` (required), optional `library` (`personal` / `team`; absent tries personal then team) | The full card fields. |
| `freshness_review` | optional `today` | The pending-review list (overdue + expiring-soon) with recommendations. |
| `heat` | — | The workspace's aggregated heat ledger. |

## Model Experience

### Read-only MCP tools

#### What the model sees

The server's four tools are model-visible to the external MCP client's model, each with a Chinese description, a JSON Schema, and a result carrying a human-readable text block plus `structuredContent` with the exact `dsh-kb-core` payload. `search_cards` (query + type/status/tier/tags filters, limit 1–50 default 10) returns the retrieval outcome with its explicit `fts`/`scan` mode; `read_card` (id, optional library) returns the full card fields; `freshness_review` (optional today) returns the pending-review list with recommendations; `heat` returns the aggregated heat ledger.

#### Token effect

The tool schemas are fixed per registration; result size scales with the returned cards, review entries, or heat rows.

#### KV Cache effect

Prefix-stable while the tool set and schemas are unchanged; results are append-only per call.

## Known Limitations and Deferred Work

- **Stdio only** — the server speaks the stdio transport; Streamable HTTP and SSE are deferred until a deployment needs them.
- **No resources or prompts** — only tools are exposed; resources and prompts await a consumer.
- **Read-only by design** — no write tools; the write side stays in the harness where `kb/*` events are logged, so external clients can never mutate the reference pool outside the logged surface.
- **The server reads one workspace root** — the deployed root is fixed per process; multi-root serving is deferred.
