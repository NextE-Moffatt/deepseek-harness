# @deepseek-ai/dsh-kb-mcp-server

[English](README.md) | 中文

一个只读的 [Model Context Protocol](https://modelcontextprotocol.io/) Server，通过 stdio 暴露知识库引用池：`search_cards` / `read_card` / `freshness_review` / `heat`，每个 handler 都是经 `ctx.kb` 的纯读。写侧留在 Harness 内（`kb_*` 工具与 web 工作台），那里 `kb/*` 事件照常入日志。[里程碑 5 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) 拥有范围决策。

## Usage

`dsh-kb-mcp` bin 启动最小组合（system-prompt / tools / kb-core / 本 Server）并服务工作区引用池，直到客户端断开。把任意 MCP 客户端指向它：

```sh
KB_MCP_ROOT=/path/to/workspace dsh-kb-mcp
```

对于以 stdio 方式拉起 Server 的 MCP 客户端（例如另一个 DSH 实例的 `mcp-client` 行），传入同样的环境变量：

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

bin 从环境变量读取部署配置：

| 变量 | 默认 | 含义 |
|---|---|---|
| `KB_MCP_ROOT` | — | 本 Server 暴露的引用池所在工作区根（必填，绝对路径）。 |
| `KB_MCP_CARDS_PATH` | `kb/cards` | 相对根的库路径。 |
| `KB_MCP_INDEX_PATH` | `kb/.kb-index.sqlite` | 相对根的 FTS5 索引库路径。 |
| `KB_MCP_HEAT_PATH` | `kb/.kb-heat.jsonl` | 相对根的热度账本路径。 |
| `KB_MCP_RECAP_PATH` | `kb/.kb-recap.jsonl` | 相对根的复盘检查点路径。 |
| `KB_MCP_TEAM_REPO_PATH` | — | 团队库 git 工作树（绝对，或相对根）。 |
| `KB_MCP_CARD_TTL_DAYS` | `90` | 缺省有效期天数。 |
| `KB_MCP_FRESHNESS_WARNING_DAYS` | `14` | 即将过期窗口天数。 |

作为 Cordis 插件，本包也暴露 `Config`（`{ root: string }`）与 `apply`，组合可以直接挂载。非法值加载时大声失败。

## Tools

四个工具全部只读；每个都返回人读文本块 + 携带 `dsh-kb-core` 原样载荷的 `structuredContent`。

| 工具 | 参数 | 结果 |
|---|---|---|
| `search_cards` | `query`（必填），`type` / `status` / `tier` / `tags` 过滤，`limit`（1–50，缺省 10） | `SearchOutcome`：FTS5 BM25 命中，或带说明的显式 `mode: 'scan'` 退化。 |
| `read_card` | `id`（必填），可选 `library`（`personal` / `team`；缺省先个人后团队） | 完整卡片字段。 |
| `freshness_review` | 可选 `today` | 待复核清单（已过期 + 即将过期）与治理建议。 |
| `heat` | — | 工作区聚合热度账本。 |

## Model Experience

### 只读 MCP 工具

#### What the model sees

四个工具对外部 MCP 客户端的模型可见，各带中文描述、JSON Schema，结果携带人读文本块 + 含 `dsh-kb-core` 原样载荷的 `structuredContent`。`search_cards`（query + type/status/tier/tags 过滤，limit 1–50 缺省 10）返回带显式 `fts`/`scan` 模式的检索结果；`read_card`（id，可选 library）返回完整卡片字段；`freshness_review`（可选 today）返回带治理建议的待复核清单；`heat` 返回聚合热度账本。

#### Token effect

工具 schema 每次注册固定；结果大小随返回的卡片、复核条目或热度行增长。

#### KV Cache effect

工具集与 schema 不变时前缀稳定；结果按调用追加。

## Known Limitations and Deferred Work

- **仅 stdio** —— Server 走 stdio 传输；Streamable HTTP 与 SSE 在有部署需求前延后。
- **无 resources 与 prompts** —— 只暴露工具；resources/prompts 等待消费者。
- **只读是设计** —— 无写工具；写侧留在 Harness 内，`kb/*` 事件照常入日志，外部客户端永远无法在已记录面之外改动引用池。
- **一个 Server 一个工作区根** —— 每个进程固定一个部署根；多根服务延后。
