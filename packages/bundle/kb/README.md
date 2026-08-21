# `@deepseek-ai/dsh-kb`

English | [中文](README.zh.md)

The opt-in knowledge-base bundle for a Web profile. [`cordis.patch.yml`](cordis.patch.yml) mounts [`@deepseek-ai/dsh-kb-core`](../../kb/kb-core/README.md), [`@deepseek-ai/dsh-kb-web`](../../kb/kb-web/README.md), and [`@deepseek-ai/dsh-client-ui-kb-workbench`](../../client/ui-kb-workbench/README.md) as one installable patch layer. The resulting profile exposes the `kb_*` tools and adds the **Knowledge Base** section to Web settings.

Install the bundle into a Web profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-kb
```

The personal library resolves from each Session workspace. A shared team library remains deployment-owned: set `teamRepoPath` on the `kb-core` row in the profile, home, or invocation patch after installing the bundle.

```yaml
- insert:
    - id: kb-core
      name: '@deepseek-ai/dsh-kb-core'
      config:
        teamRepoPath: /absolute/path/to/team-repo
        packs: []
```

The path must name a git work tree containing `cards/`; optional human-readable wiki documents live under `docs/`. The workbench reads and writes the working tree, while `kb_team_commit` remains the explicit commit operation.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-kb-core`, which contributes the knowledge tools and configured knowledge-pack context.

#### KV Cache effect

The bundle adds no model tokens of its own; the mounted `kb-core` package owns the conditional prompt and tool-schema effects.

## Known Limitations and Deferred Work

- **Web composition only** — the bundle always mounts the browser workbench halves and therefore targets profiles that already provide the Web Host and Client services; headless deployments should mount `@deepseek-ai/dsh-kb-core` directly.
- **Team repository configuration stays outside the bundle** — one portable bundle cannot choose a host path or write-approval policy for every installation; deployments replace the complete `kb-core` row and must restate `packs` when setting those fields.
