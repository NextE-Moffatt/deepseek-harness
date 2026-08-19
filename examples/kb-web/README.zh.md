# kb-web

[English](README.md) | 中文

[知识库治理工作台](../../packages/kb/kb-web/README.md)的可选 Web 组合：浏览器设置页里的待复核清单、卡片详情、生命周期动作与飞轮看板。kb-core 与工作台主机/客户端半**不在**出厂 `dsh-base` / `dsh-web-app` bundle 中；本 overlay 负责挂载。

## Run it

```sh
dsh web --patch examples/kb-web/cordis.yml
```

打开 Web 界面，进入设置，选择 **知识库**。工作台需要一个含 kb 数据的工作区 session——先用 `kb_*` 工具写卡片（见 [kb-core README](../../packages/kb/kb-core/README.md)），然后保鲜清单、复盘盲点与飞轮指标就会出现。

团队库可选：存在共享 git 仓库时在 overlay 中取消 `teamRepoPath` 注释（绝对路径，或相对 session 工作区根）。

## What the overlay mounts

| 行 | 包 | 角色 |
|---|---|---|
| `kb-core` | `@deepseek-ai/dsh-kb-core` | 知识库服务与工具。 |
| `kb-web` | `@deepseek-ai/dsh-kb-web` | 工作台 Remote 服务（`ctx.kbWorkbench`）。 |
| `kb-workbench` | `@deepseek-ai/dsh-client-ui-kb-workbench` | 浏览器设置 section。 |

## Read-only MCP exposure

要改为（或同时）把引用池暴露给外部 MCP 客户端，运行只读 MCP Server：见 [kb-mcp-server README](../../packages/kb/kb-mcp-server/README.md)。
