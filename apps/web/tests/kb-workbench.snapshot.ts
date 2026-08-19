// @vitest-environment jsdom
// Assembled kb-workbench snapshot: boots the real built `packages/client/*/
// lib/client.js` bundles through AppWebEntry's ModuleLoader path against the
// keyless FixtureApiClient transport, opens the settings shell, navigates to
// the Knowledge Base section, and pins the flywheel metrics, the merged
// pending-review list, and the draft card detail with its promotion action.
// The fixture serves the kbWorkbench remote (see fixture.ts); no model round
// or API key is involved.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasClass, installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const OVERVIEW_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/kb-workbench/overview.expected.txt')
const DETAIL_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/kb-workbench/detail.expected.txt')
const EDITED_EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/kb-workbench/edited.expected.txt')

installAssembledBootEnv()

/** Collect elements carrying a logical CSS-module class. */
function byClass(root: ParentNode, name: string): Element[] {
  return [...root.querySelectorAll('*')].filter(el => hasClass(el, name))
}

/** The first element with the logical class, or its text (whitespace-normalized). */
function firstText(root: ParentNode, name: string): string {
  return byClass(root, name)[0]?.textContent?.trim().replace(/\s+/g, ' ') ?? '<absent>'
}

/** Normalize the workbench's overview surface to stable text fields. */
function overviewShape(): string {
  const tiles = byClass(document, 'metricTile').map(tile =>
    `${firstText(tile, 'metricLabel')}=${firstText(tile, 'metricValue')}`)
  const topHeat = firstText(document, 'topHeat')
  const rows = byClass(document, 'reviewRow').map(row =>
    row.textContent?.trim().replace(/\s+/g, ' ') ?? '<absent>')
  return [
    `tiles=${tiles.join(' | ')}`,
    `topHeat=${topHeat}`,
    `rows=${rows.join(' || ')}`,
  ].join('\n')
}

/** Normalize the open card detail to stable text fields. */
function detailShape(): string {
  // The workbench detail is the last dl; its actions are the last 'actions'
  // class group (settings chrome also carries an actions slot).
  const fields = [...document.querySelectorAll('dl')].pop()
  const actions = byClass(document, 'actions').pop()
  const actionText = actions === undefined
    ? '<absent>'
    : [...actions.querySelectorAll('button')].map(button => button.textContent?.trim() ?? '').join('|')
  return [
    `detail=${fields?.textContent?.trim().replace(/\s+/g, ' ') ?? '<absent>'}`,
    `actions=${actionText}`,
  ].join('\n')
}

async function openWorkbenchSection(): Promise<void> {
  mountAssembledApp()
  // The settings trigger (the shell's `aria-haspopup="dialog"` button).
  const trigger = await waitFor(() => {
    const found = document.querySelector('button[aria-haspopup="dialog"]')
    if (found === null) throw new Error('settings trigger not mounted')
    return found as HTMLButtonElement
  }, { timeout: 10_000 })
  fireEvent.click(trigger)
  // The English nav label (the lane pins en-US).
  const nav = await screen.findByRole('button', { name: 'Knowledge Base' }, { timeout: 10_000 })
  fireEvent.click(nav)
  // The section renders once the fixture overview lands.
  await waitFor(() => {
    expect(screen.getByText('Injections')).toBeDefined()
  }, { timeout: 10_000 })
}

describe('assembled kb workbench surface', () => {
  it('renders the flywheel metrics, top heat, and the merged pending-review list', async () => {
    await openWorkbenchSection()
    const shape = overviewShape()
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(OVERVIEW_EXPECTED), { recursive: true })
      writeFileSync(OVERVIEW_EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(OVERVIEW_EXPECTED)
  })

  it('opens the draft card detail from a blind-spot consumed card and shows the promotion action', async () => {
    await openWorkbenchSection()
    // The blind spot's consumed card link opens the draft detail.
    const blindSpot = screen.getByText('Recap blind spots').closest('li')
    expect(blindSpot).not.toBeNull()
    // The row carries the consumed list span and a per-card link button; the
    // clickable card link is the last match.
    const consumed = within(blindSpot!).getAllByText(/rule-20260818-001/)
    fireEvent.click(consumed[consumed.length - 1]!)
    // The detail heading is "Card detail：<title>", so match the title
    // substring across the detail surface.
    await waitFor(() => {
      expect(screen.getAllByText(/告警处置标准/).length).toBeGreaterThan(0)
    }, { timeout: 10_000 })
    const shape = detailShape()
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(DETAIL_EXPECTED), { recursive: true })
      writeFileSync(DETAIL_EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(DETAIL_EXPECTED)
  })

  it('edits a card field through the form and the refreshed detail carries the saved title', async () => {
    await openWorkbenchSection()
    // Open the draft card detail from the blind-spot consumed card.
    const blindSpot = screen.getByText('Recap blind spots').closest('li')
    const consumed = within(blindSpot!).getAllByText(/rule-20260818-001/)
    fireEvent.click(consumed[consumed.length - 1]!)
    await waitFor(() => {
      expect(screen.getAllByText(/告警处置标准/).length).toBeGreaterThan(0)
    }, { timeout: 10_000 })
    // Enter the edit form, change the title and the condition, save.
    fireEvent.click(screen.getByText('Edit'))
    const title = await screen.findByLabelText('Title') as HTMLInputElement
    fireEvent.change(title, { target: { value: '编辑后的告警处置标准' } })
    const condition = screen.getByLabelText('When to use') as HTMLTextAreaElement
    fireEvent.change(condition, { target: { value: '值班收到新告警' } })
    fireEvent.click(screen.getByText('Save'))
    // The form closes and the refreshed detail shows the saved fields.
    await waitFor(() => {
      expect(screen.getAllByText(/编辑后的告警处置标准/).length).toBeGreaterThan(0)
    }, { timeout: 10_000 })
    expect(screen.queryByText('Save')).toBeNull()
    const shape = detailShape()
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EDITED_EXPECTED), { recursive: true })
      writeFileSync(EDITED_EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EDITED_EXPECTED)
  })
})
