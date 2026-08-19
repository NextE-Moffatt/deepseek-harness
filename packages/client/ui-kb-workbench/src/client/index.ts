/**
 * Knowledge-base governance workbench plugin, browser half: one settings
 * section (id `kb-workbench`) rendering the pending-review list, the card
 * detail, the lifecycle actions, and the flywheel dashboard. All data and
 * mutations ride the generated `kbWorkbench` Remote namespace — this plugin
 * owns no state machine and no second event stream.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the
// Client assembly boundary (the kbWorkbench namespace mounts there).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { WorkbenchSection } from './WorkbenchSection.tsx'
import type { WorkbenchSectionInjected } from './WorkbenchSection.tsx'
import { en, NS, zh, type KbWorkbenchKey } from './locales.ts'

export type { WorkbenchSection, WorkbenchSectionInjected } from './WorkbenchSection.tsx'
export type { KbWorkbenchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The kb workbench settings section copy. */
    'kb.workbench': KbWorkbenchKey
  }
}

/** Required services for the settings entry, copy, and the Remote namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.kbWorkbench']

/**
 * Client plugin body: register the section and its Remote-backed face.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS) as (key: KbWorkbenchKey) => string
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-kb-workbench: dictionaries')

  const injected = (): WorkbenchSectionInjected => ({
    t,
    overview: (sessionId: SessionId, today?: string) => ctx.remote.kbWorkbench.overview(sessionId, today),
    card: (sessionId: SessionId, id: string) => ctx.remote.kbWorkbench.card(sessionId, id),
    promote: (sessionId: SessionId, id: string, target, evidence?: string) =>
      ctx.remote.kbWorkbench.promote(sessionId, id, target, evidence),
    archive: (sessionId: SessionId, id: string) => ctx.remote.kbWorkbench.archive(sessionId, id),
    revive: (sessionId: SessionId, id: string) => ctx.remote.kbWorkbench.revive(sessionId, id),
    review: (sessionId: SessionId, id: string, approved: boolean) =>
      ctx.remote.kbWorkbench.review(sessionId, id, approved),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'kb-workbench',
    order: 30,
    label: () => t('nav'),
    inject: injected,
  }, WorkbenchSection))
}
