# 知识库

[English](kb.md) | 中文

里程碑 1 个人知识库：`ctx.kb` 持有卡片读写、晋升状态机、带扫描降级契约的 FTS5 检索与增量采集，并注册 `kb_write` / `kb_read` / `kb_search` / `kb_promote` 工具。[设计 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md) 持有包组决策；本页记录 [`packages/kb/kb-core/src/types.ts`](../../packages/kb/kb-core/src/types.ts) 的确切类型。

## Card model

卡片 = Markdown + YAML front matter，两库共用一套规范。中文 front matter 键（库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签）是定稿的用户可见格式，并逐字镜像为 TypeScript 属性名；正文的 核心结论 / 应做 / 不应做 / 反例 / 踩坑记录 节解析为其余字段。

```ts type-equiv
/**
 * A knowledge-card id, unique across one library. The design's id format is
 * `{type}-YYYYMMDD-{seq}` (for example `rule-20250818-001`); the format is
 * enforced by the card parser, not by this brand.
 */
type CardId = Branded<'CardId'>
```

```ts type-equiv
/** The four knowledge-card types of the shared card spec (§4.1). */
type CardType = 'rule' | 'case' | 'howto' | 'decision'
```

```ts type-equiv
/** Which library a card belongs to. Milestone 1 ships `personal`; `team` is the shared git repo (post-milestone-1). */
type CardLibrary = 'personal' | 'team'
```

```ts type-equiv
/**
 * Lifecycle states of the promotion pipeline. `draft` is the personal-library
 * entry state; `pending` awaits verification; `ready` is the reference pool;
 * `archived` is retired; `revived` is a restored-active state, distinct from
 * never-archived `ready` so governance can tell the two apart.
 */
type CardStatus = 'draft' | 'pending' | 'ready' | 'archived' | 'revived'
```

```ts type-equiv
/** Personal-library tiers, encoded as the card's directory: P0 Inbox, P1 project notes, P2 draft cards, P3 private experience. */
type CardTier = 'P0' | 'P1' | 'P2' | 'P3'
```

晋升状态机是闭合链 `draft → pending → ready → archived → revived`，`revived → archived` 可再归档；`kb_promote` 只暴露晋升子集（目标 `pending` 与 `ready`）。卡片解析对未知键、缺失必填字段、非法日期与未知枚举值 loud fail；应做 / 不应做 节对导入卡片允许为空，而 `kb_write` 工具要求每侧至少一项。

## Search contract

`CardIndex` 在 `kb/.kb-index.sqlite`（`indexPath` 配置）上按库根目录运行 FTS5 `unicode61`（BM25），另配普通 `cards` 表做结构化过滤（type / 状态 / tier / tags）。中日韩/假名连续段在索引与查询两侧都按字切分，子串检索无需分词词典。降级契约显式化：索引无法打开时 `search` 返回确定性扫描模式结果（`mode: 'scan'`，同一套过滤 + 说明），绝不编造答案。

## Session events

状态变更必须入日志：`kb/write` 记录工具执行的卡片写入，`kb/promote` 记录状态流转。两者都在文件操作成功后追加，模型可见面可从 session 日志回放。完整载荷声明见 [persistence catalog](../persistence-catalog.md#kbpromote--log-only)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkb--kbservice"></a>

### `ctx.kb` — `KbService`

`ctx.kb`: owns the personal library seam — card write/read, promotion, search, and incremental ingest — plus the milestone-1 tools.

```ts cordis-catalog
/**
 * Write a new personal-library draft card, generating the id when omitted.
 * @param root - the session workspace root.
 * @param input - the card to write (values validated at the tool boundary).
 * @returns the written card, tier, and absolute path.
 */
async writeCard(root: string, input: WriteCardInput): Promise<CardWriteResult>

/**
 * Read one card by id across all tiers.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the card file info; throws when no tier holds the id.
 */
async readCard(root: string, id: CardId): Promise<CardFileInfo>

/**
 * Search one library: FTS5 BM25 with structured filters when the index is
 * available, otherwise a deterministic full-library scan with an explicit
 * `mode: 'scan'` note. Results are always real card files.
 * @param root - the session workspace root.
 * @param request - the retrieval request.
 * @returns the retrieval outcome with its mode.
 */
async search(root: string, request: SearchRequest): Promise<SearchOutcome>

/**
 * Apply a promotion transition: assert the state machine, rewrite the card
 * file, and return the new state. The caller (tool) appends `kb/promote`.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @param target - the requested next state (promotion subset: `pending` or `ready`).
 * @param evidence - optional objective signal.
 * @returns the card in its new state plus the transition.
 */
async promote(root: string, id: CardId, target: CardStatus, evidence?: string): Promise<PromoteResult>

/**
 * Run the incremental ingest over a source directory into the library at
 * `options.root` (see {@link importDir}).
 * @param options - import options.
 * @returns the import outcome.
 */
importDir(options: ImportOptions): Promise<IngestResult>
```

Source: [`packages/kb/kb-core/src/index.ts:170`](../../packages/kb/kb-core/src/index.ts)
<!-- END GENERATED cordis-surface -->
