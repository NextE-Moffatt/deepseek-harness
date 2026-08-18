/**
 * kb-inject wiring: the synchronous `agent/session-start` injection listener
 * and the `kb:pack` prompt section. The event is the single source of truth —
 * the listener appends `kb/injected` (with the full rendered content) before
 * the first prompt assembly, and the section folds the log, so every request
 * carries the packs and replay reproduces the section from the log alone.
 * The listener reads the personal library and, when a team repository is
 * configured, the team library; both contribute cards to pack selection.
 * @module @deepseek-ai/dsh-kb-core/inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PersonalCardStore } from './store.ts'
import { TeamCardStore } from './team.ts'
import { KB_PACK_SECTION, KB_PACK_SECTION_ORDER, foldInjected, hasInjectedPack, renderCardSection, selectPackCards, type PackEntry } from './pack.ts'
import type { KbService } from './index.ts'

/** The plugin name recorded in injection diagnostics. */
const PLUGIN = 'dsh-kb-core'

/**
 * Inject every configured pack into one agent session, synchronously.
 * Session-start emits do not await listeners, and the first prompt assembly
 * can begin immediately after the agent is published, so the selection reads
 * the libraries through the stores' sync paths. Each pack injects once per
 * session (the log fold is the guard); sessions without a workspace skip
 * injection, packs matching zero cards append nothing, and a per-pack failure
 * logs and continues without breaking agent publication. A configured team
 * repository that cannot be read logs and contributes nothing — the personal
 * side still injects.
 * @param ctx - registrant context, for diagnostics.
 * @param kb - the kb service holding the resolved pack config.
 * @param agent - the agent whose session just started.
 */
export function injectPacks(ctx: Context, kb: KbService, agent: Agent): void {
  const cwd = agent.session.header.cwd
  if (cwd === undefined || kb.config.packs.length === 0) return
  let entries: PackEntry[] = []
  try {
    const personal = new PersonalCardStore(cwd, kb.config.cardsPath).listSync()
    for (const failure of personal.failures) {
      ctx.logger.debug(`${PLUGIN}: ignoring unparseable card file %s: %s`, failure.path, failure.message)
    }
    entries = personal.cards.map(info => ({ card: info.card, tier: info.tier, path: info.path }))
  } catch (error) {
    ctx.logger.warn(`${PLUGIN}: failed to read the personal library at session start for agent "${agent.id}": %o`, error)
    return
  }
  if (kb.config.teamRepoPath !== undefined) {
    try {
      const team = new TeamCardStore(kb.teamRepoRoot(cwd)).listSync()
      for (const failure of team.failures) {
        ctx.logger.debug(`${PLUGIN}: ignoring unparseable team card file %s: %s`, failure.path, failure.message)
      }
      entries = [...entries, ...team.cards.map(info => ({ card: info.card, path: info.path }))]
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: failed to read the team library at session start for agent "${agent.id}": %o`, error)
    }
  }
  for (const pack of kb.config.packs) {
    try {
      if (hasInjectedPack(agent.session.events, pack.name)) continue
      const selected = selectPackCards(entries, pack)
      if (selected.length === 0) continue
      agent.session.append('kb/injected', {
        pack: pack.name,
        cardIds: selected.map(entry => entry.card.id),
        sections: selected.map(entry => renderCardSection(entry.card)),
      })
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: failed to inject knowledge pack "${pack.name}" at session start for agent "${agent.id}": %o`, error)
    }
  }
}

/**
 * Register the kb-inject wiring on `ctx`: the session-start injection listener
 * and the `kb:pack` prompt section rendering the fold of the session log.
 * @param ctx - registrant context carrying the agent event bus and systemPrompt.
 * @param kb - the kb service holding the resolved pack config.
 */
export function registerKbInjection(ctx: Context, kb: KbService): void {
  ctx.on('agent/session-start', ({ agent }) => {
    injectPacks(ctx, kb, agent)
  })
  ctx.systemPrompt.section({
    name: KB_PACK_SECTION,
    order: KB_PACK_SECTION_ORDER,
    text: context => context.agent === undefined ? '' : foldInjected(context.agent.session.events),
  })
}
