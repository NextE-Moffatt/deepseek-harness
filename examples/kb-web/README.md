# kb-web

English | [中文](README.zh.md)

Opt-in Web composition for the [knowledge-base governance workbench](../../packages/kb/kb-web/README.md): the pending-review list, card detail, lifecycle actions, and flywheel dashboard in the browser settings. kb-core and the workbench host/client halves are **not** part of the shipped `dsh-base` / `dsh-web-app` bundles; this overlay mounts them.

## Run it

```sh
dsh web --patch examples/kb-web/cordis.yml
```

Open the web interface, open Settings, and choose **知识库** (Knowledge Base). The workbench needs a session whose workspace contains kb data — write cards with the `kb_*` tools first (see the [kb-core README](../../packages/kb/kb-core/README.md)), then the freshness list, recap blind spots, and flywheel metrics appear.

The team library is optional: uncomment `teamRepoPath` in the overlay when a shared git repository exists (absolute, or relative to the session workspace root).

## What the overlay mounts

| Row | Package | Role |
|---|---|---|
| `kb-core` | `@deepseek-ai/dsh-kb-core` | The knowledge-base service and tools. |
| `kb-web` | `@deepseek-ai/dsh-kb-web` | The workbench Remote service (`ctx.kbWorkbench`). |
| `kb-workbench` | `@deepseek-ai/dsh-client-ui-kb-workbench` | The browser settings section. |

## Read-only MCP exposure

To serve the reference pool to external MCP clients instead (or in addition), run the read-only MCP server: see the [kb-mcp-server README](../../packages/kb/kb-mcp-server/README.md).
