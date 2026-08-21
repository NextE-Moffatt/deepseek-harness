# Agent Note: 可安装的知识库 Profile 组合包

Status: implemented

[English](2026-08-21-kb-profile-bundle.md) | 中文

## Problem

知识库能力由三个各自持有运行时职责的包组成，但需要完整 Web 体验的运维方原本必须在每个 profile 中重复组合它们并维护依赖闭包。团队仓库路径指向部署持有的存储，因此无法成为可移植配置。

## Decision

`@deepseek-ai/dsh-kb` 是 `packages/bundle/kb` 下的可选 Profile 组合包。其 manifest 通过 `dsh.bundle.patch` 指向一份已提交 patch，该 patch 挂载 `kb-core`、`kb-web` 与 `ui-kb-workbench`。组合包把这三个包声明为运行时依赖，因此一次安装即可携带完整的 Web 知识库组合。

patch 提供空 `packs` 列表，并有意省略 `teamRepoPath` 与 `teamWriteApproval`。启用团队库的部署在后续 profile、home 或调用 patch 中替换完整 `kb-core` 行，并在那里声明主机路径与策略。由于该组合包始终包含 Web Host 与 Client 消费方，headless 部署直接挂载 `kb-core`。

## Distribution contract

组合包目录是独立的 GitHub 安装目标：`package.json` 与 `cordis.patch.yml` 一同提交，manifest 的 repository directory 指向同一路径。包测试使用真实 Loader schema 解析 patch，并固定三条配置行与依赖名称。

## Alternatives considered

**把知识库包加入出厂 Web 组合包。** 这会让该能力进入每个 Web 安装，违反可选组合要求。

**把团队仓库路径写入组合包。** 组合包无法跨主机选择有效的共享工作树或审批策略，而回退路径会静默绑定错误存储。

**只发布 `kb-core`。** 这能支持 headless 工具，但不能交付市场条目用户所期望的治理工作台。

## Consequences

运维方可以通过一个包安装完整 Web 体验，个人与团队存储仍沿用既有 `kb-core` 语义。组合增加一个分发包和一对文档。部署仍须用后续 patch 配置团队库，并且该组合包不是最小 headless 组合。
