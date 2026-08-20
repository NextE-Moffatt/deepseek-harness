/**
 * The team wiki docs block of the knowledge-base governance workbench: the
 * `docs/` document list, a read view, an edit form, and a remove action —
 * all through the `kbWorkbench` Remote namespace (listDocs / readDoc /
 * writeDoc / removeDoc). The host gates every write and removal under
 * `teamWriteApproval`; this block's confirmation checkbox and the delete
 * confirmation carry that approval signal, exactly like the card edit form.
 * Docs never enter the reference pool — this surface is human reading and
 * maintenance material only.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { KbWorkbenchDoc, KbWorkbenchDocOptions } from '@deepseek-ai/dsh-kb-web/client'
import type { KbWorkbenchKey } from './locales.ts'
import styles from './WorkbenchSection.module.css'

/** The inject face the workbench section spreads into the docs block. */
export interface TeamDocsInjected {
  /** Bound section copy. */
  t: (key: KbWorkbenchKey) => string
  /** The team library's `docs/` paths, repository-relative. */
  listDocs: (sessionId: SessionId) => Promise<RemoteResult<string[]>>
  /** One wiki document with the file identity the write guard expects. */
  readDoc: (sessionId: SessionId, docPath: string) => Promise<RemoteResult<KbWorkbenchDoc>>
  /** Overwrite one wiki document (conflict-guarded, team-gated). */
  writeDoc: (
    sessionId: SessionId,
    docPath: string,
    content: string,
    options?: KbWorkbenchDocOptions,
  ) => Promise<RemoteResult<KbWorkbenchDoc>>
  /** Remove one wiki document (team-gated). */
  removeDoc: (
    sessionId: SessionId,
    docPath: string,
    options?: KbWorkbenchDocOptions,
  ) => Promise<RemoteResult<{ path: string }>>
}

/** Props delivered by the workbench section: the active session seat plus the docs face. */
export type TeamDocsProps = {
  /** The workbench session whose workspace serves the team library. */
  sessionId: SessionId
} & {
  [K in keyof TeamDocsInjected]?: TeamDocsInjected[K] | undefined
}

/**
 * The team wiki docs block body.
 * @param props - the active session seat plus the injected docs face.
 * @returns the docs list, read view, and edit/remove actions.
 */
export function TeamDocs(props: TeamDocsProps): ReactNode {
  // v8 ignore next -- the section always passes a bound t; the default only guards a direct render
  const { sessionId, t = () => '', listDocs, readDoc, writeDoc, removeDoc } = props
  const [docs, setDocs] = useState<string[] | undefined>(undefined)
  const [openDoc, setOpenDoc] = useState<KbWorkbenchDoc | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [approved, setApproved] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const loadDocs = useCallback(async (target: SessionId): Promise<void> => {
    if (listDocs === undefined) return
    setError(undefined)
    const result = await listDocs(target)
    if (result.ok) {
      setDocs(result.value)
    } else {
      setError(result.error.message)
    }
  }, [listDocs])

  useEffect(() => {
    void loadDocs(sessionId)
  }, [loadDocs, sessionId])

  const open = useCallback(async (docPath: string): Promise<void> => {
    if (readDoc === undefined) return
    setEditing(false)
    setConfirmingRemove(false)
    setError(undefined)
    const result = await readDoc(sessionId, docPath)
    if (result.ok) {
      setOpenDoc(result.value)
      setDraft(result.value.content)
    } else {
      setError(result.error.message)
    }
  }, [readDoc, sessionId])

  const save = useCallback(async (): Promise<void> => {
    /* v8 ignore next -- the save button renders only with an open doc and the write face */
    if (openDoc === undefined || writeDoc === undefined) return
    /* v8 ignore next -- the submit button is disabled while busy */
    if (busy) return
    setBusy(true)
    setError(undefined)
    const options: KbWorkbenchDocOptions = {
      /* v8 ignore next -- openDoc always captures the identity before the form renders */
      ...{ expected: { mtime: openDoc.mtime, size: openDoc.size } },
      approved,
    }
    const result = await writeDoc(sessionId, openDoc.path, draft, options)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setEditing(false)
    setOpenDoc(result.value)
    setDraft(result.value.content)
    await loadDocs(sessionId)
  }, [approved, busy, draft, loadDocs, openDoc, sessionId, writeDoc])

  const remove = useCallback(async (): Promise<void> => {
    /* v8 ignore next -- the delete button renders only with an open doc and the remove face */
    if (openDoc === undefined || removeDoc === undefined) return
    /* v8 ignore next -- the buttons are disabled while busy */
    if (busy) return
    setBusy(true)
    setError(undefined)
    const result = await removeDoc(sessionId, openDoc.path, { approved: true })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setOpenDoc(undefined)
    setConfirmingRemove(false)
    await loadDocs(sessionId)
  }, [busy, loadDocs, openDoc, removeDoc, sessionId])

  return (
    <div className={styles.docs}>
      <h2 className={styles.sectionTitle}>{t('docs.title')}</h2>
      {error !== undefined && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.retry} onClick={() => { void loadDocs(sessionId) }}>
            {t('error.reload')}
          </button>
        </div>
      )}
      {docs === undefined && error === undefined && <p className={styles.hint}>{t('action.busy')}</p>}
      {docs !== undefined && docs.length === 0 && <p className={styles.hint}>{t('docs.empty')}</p>}
      {docs !== undefined && docs.length > 0 && (
        <ul className={styles.docList}>
          {docs.map(docPath => (
            <li key={docPath} className={styles.docRow}>
              <button type="button" className={styles.cardLink} onClick={() => { void open(docPath) }}>
                {docPath}
              </button>
              {openDoc?.path === docPath && <span className={styles.reviewBadge}>{t('docs.open')}</span>}
            </li>
          ))}
        </ul>
      )}

      {openDoc !== undefined && (
        <div className={styles.detail}>
          <h3 className={styles.docTitle}>{openDoc.path}</h3>
          {editing ? (
            <form className={styles.editForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
              <label className={styles.editField}>
                <span>{t('docs.content')}</span>
                <textarea
                  className={styles.docTextarea}
                  rows={8}
                  value={draft}
                  onChange={(event) => { setDraft(event.target.value) }}
                />
              </label>
              <label className={styles.editField}>
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(event) => { setApproved(event.target.checked) }}
                />
                <span>{t('edit.approval')}</span>
              </label>
              <div className={styles.actions}>
                <button type="submit" className={styles.action} disabled={busy}>
                  {busy ? t('action.busy') : t('docs.save')}
                </button>
                <button type="button" className={styles.action} disabled={busy}
                  onClick={() => { setEditing(false); setDraft(openDoc.content) }}>
                  {t('docs.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className={styles.docContent}>{openDoc.content}</p>
              <div className={styles.actions}>
                <button type="button" className={styles.action} disabled={busy}
                  onClick={() => { setEditing(true); setDraft(openDoc.content); setApproved(false); setConfirmingRemove(false) }}>
                  {t('docs.edit')}
                </button>
                {confirmingRemove ? (
                  <>
                    <button type="button" className={styles.action} disabled={busy} onClick={() => { void remove() }}>
                      {busy ? t('action.busy') : t('docs.confirmDelete')}
                    </button>
                    <button type="button" className={styles.action} disabled={busy}
                      onClick={() => { setConfirmingRemove(false) }}>
                      {t('docs.cancel')}
                    </button>
                  </>
                ) : (
                  <button type="button" className={styles.action} disabled={busy}
                    onClick={() => { setConfirmingRemove(true) }}>
                    {t('docs.delete')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
