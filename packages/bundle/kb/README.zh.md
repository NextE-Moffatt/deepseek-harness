# `@deepseek-ai/dsh-kb`

[English](README.md) | 中文

面向 Web profile 的可选知识库组合包。[`cordis.patch.yml`](cordis.patch.yml) 把 [`@deepseek-ai/dsh-kb-core`](../../kb/kb-core/README.md)、[`@deepseek-ai/dsh-kb-web`](../../kb/kb-web/README.md) 与 [`@deepseek-ai/dsh-client-ui-kb-workbench`](../../client/ui-kb-workbench/README.md) 作为一个可安装 patch 层挂载。组合后的 profile 提供 `kb_*` 工具，并在 Web 设置中增加**知识库** section。

把组合包安装进 Web profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-kb
```

个人库从每个 Session workspace 解析。共享团队库仍由部署配置：安装组合包后，在 profile、home 或调用 patch 中为 `kb-core` 行设置 `teamRepoPath`。

```yaml
- insert:
    - id: kb-core
      name: '@deepseek-ai/dsh-kb-core'
      config:
        teamRepoPath: /absolute/path/to/team-repo
        packs: []
```

该路径必须指向包含 `cards/` 的 git 工作树；可选的人读 wiki 文档位于 `docs/`。工作台读写工作树，`kb_team_commit` 仍是显式提交操作。

## Model Experience

间接通过 `@deepseek-ai/dsh-kb-core` 产生影响，该包贡献知识工具与已配置的知识包上下文。

#### KV Cache effect

组合包本身不增加模型 token；条件提示词与工具 schema 的影响归挂载的 `kb-core` 包所有。

## Known Limitations and Deferred Work

- **仅适用于 Web 组合**——组合包始终挂载浏览器工作台两侧，因此目标 profile 必须已经提供 Web Host 与 Client 服务；headless 部署应直接挂载 `@deepseek-ai/dsh-kb-core`。
- **团队仓库配置留在组合包之外**——一个可移植组合包无法替每个安装选择主机路径或写审批策略；部署在设置这些字段时会替换完整 `kb-core` 行，因此必须重述 `packs`。
