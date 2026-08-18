# 知识库

[English](kb.md) | 中文

个人知识库：`ctx.kb` 持有卡片读写、晋升状态机、带扫描降级契约的 FTS5 检索、增量采集与会话启动时的知识包注入，并注册 `kb_write` / `kb_read` / `kb_search` / `kb_promote` 工具。[设计 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md) 持有包组决策，[注入 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-inject.md) 持有知识包决策；本页记录 [`packages/kb/kb-core/src/types.ts`](../../packages/kb/kb-core/src/types.ts) 的确切类型。

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

状态变更必须入日志：`kb/write` 记录工具执行的卡片写入，`kb/promote` 记录状态流转，`kb/injected` 记录一次会话启动时的知识包注入。三者都在底层操作成功后追加，模型可见面可从 session 日志回放；`kb/injected` 携带完整渲染后的卡片节，`kb:pack` prompt section 仅凭日志即可重建。完整载荷声明见 [persistence catalog](../persistence-catalog.md#kbpromote--log-only)。

## Knowledge packs

知识包 = 按订阅注入到 agent 会话的卡片集合。部署配置的包清单本身就是场景订阅——每个包携带选择卡片的过滤条件：

```ts type-equiv
/**
 * A knowledge pack: a subscribed card collection injected into agent sessions
 * at session start. The deployment's configured pack list IS the scenario
 * subscription — each pack carries the filters that select its cards.
 */
interface KnowledgePack {
  /** Unique pack name, shown to the model as the pack header. */
  name: string
  /** Filter: every listed tag must be present on the card. */
  tags?: readonly string[]
  /** Filter: tier allowlist. */
  tier?: readonly CardTier[]
  /** Filter: status allowlist; when absent, `archived` cards are excluded by default. */
  status?: readonly CardStatus[]
  /** Maximum cards injected per session; no cap when absent. */
  limit?: number
}
```

```ts type-equiv
/** One injected card's rendered section, the replayable unit of a pack injection. */
interface PackSection {
  /** The card id, also the rendered heading. */
  name: string
  /** The rendered card content (title / 适用条件 / 核心结论 / 应做 / 不应做 / optional 反例). */
  text: string
}
```

包在 `KbConfig.packs` 下声明，加载时校验（非空唯一 name、闭合枚举 tier/status、正整数 limit、无未知键）。`agent/session-start` 时注入监听器同步读库，按包选择卡片（`tags` 必须全含、tier/status 白名单、缺省排除 `archived`、按 id 升序、按 `limit` 截断），每包追加一条携带渲染节的 `kb/injected` 事件。`kb:pack` prompt section fold 这些事件，为每个请求渲染包头与卡片块。注入按"每会话每包一次"（以日志 fold 为守卫），resume 与 fork 继承注入，回放逐字节复现该 section。无 workspace 的会话跳过注入，零命中卡片不追加，单包失败记日志并继续。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkb--kbservice"></a>

### `ctx.kb` — `KbService`

`ctx.kb`: owns the personal library seam — card write/read, promotion, search, and incremental ingest — plus the milestone-1 tools and the knowledge-pack injection wiring (session-start trigger + `kb:pack` section).

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

Source: [`packages/kb/kb-core/src/index.ts:183`](../../packages/kb/kb-core/src/index.ts)
<!-- END GENERATED cordis-surface -->
