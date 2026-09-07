import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type UserRow } from '../lib/api'
import type { SignedInUser } from '../types'
import Icon from '../ui/Icon'

/**
 * The allowlist, in the app.
 *
 * Approving someone used to mean opening the data Sheet and typing `lister`
 * into a cell — which is fine for Brien and impossible for anyone standing in
 * a factory being asked to let a colleague in. Access is how this app is
 * granted and revoked, so it belongs on a screen.
 *
 * The backend refuses every action here for a non-admin (403), so this is a
 * convenience over the Sheet, never the thing that enforces the rule.
 */
const ROLES = [
  { id: 'lister', label: 'Can list', hint: 'List SKUs, sync and export orders' },
  { id: 'admin', label: 'Admin', hint: 'Everything, including this screen' },
  { id: 'blocked', label: 'Blocked', hint: 'Signed in, refused everything' },
] as const

export default function Users({ me }: { me: SignedInUser & { admin?: boolean } }) {
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setRows(await api.users())
    } catch (e: unknown) {
      setRows([])
      setError(e instanceof ApiError ? e.display : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function change(row: UserRow, role: string) {
    setBusy(row.email)
    setError('')
    setNote('')
    try {
      await api.setRole(row.email, role)
      const label = ROLES.find((r) => r.id === role)?.label ?? role
      setNote(`${row.name || row.email} — ${label}.`)
      await load()
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setBusy('')
    }
  }

  if (!me.admin) {
    return (
      <div className="space-y-3">
        <Header />
        <p className="text-sm text-muted bg-raised border border-line2 rounded-xl px-4 py-3">
          Only an admin can see who has access. Ask Brien.
        </p>
      </div>
    )
  }

  const waiting = (rows ?? []).filter((r) => r.role === 'pending')
  const active = (rows ?? []).filter((r) => r.role !== 'pending')

  return (
    <div className="space-y-3">
      <Header />

      {note && (
        <p className="text-xs text-ok bg-ok-tint border border-ok-line rounded-lg px-3 py-2">{note}</p>
      )}
      {error && (
        <p className="text-sm text-bad bg-bad-tint border border-bad-line rounded-lg px-3 py-2">{error}</p>
      )}

      {rows === null ? (
        <p className="text-sm text-faint py-8 text-center">Loading…</p>
      ) : (
        <>
          {waiting.length > 0 && (
            <section className="bg-raised border border-warn-line rounded-xl overflow-hidden">
              <p className="text-xs font-semibold tracking-wide text-warn uppercase px-3 pt-3 pb-1">
                Waiting for approval
              </p>
              {waiting.map((row) => (
                <div key={row.email} className="px-3 py-3 border-t border-hair space-y-2">
                  <Who row={row} />
                  <div className="flex gap-2">
                    <button
                      onClick={() => void change(row, 'lister')}
                      disabled={busy === row.email}
                      className="flex-1 min-h-11 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 text-sm font-medium text-white flex items-center justify-center gap-1.5"
                    >
                      <Icon name="check" size={18} />
                      {busy === row.email ? 'Approving…' : 'Approve'}
                    </button>
                    <button
                      onClick={() => void change(row, 'blocked')}
                      disabled={busy === row.email}
                      className="min-h-11 px-4 rounded-lg border border-line text-sm text-muted disabled:opacity-50"
                    >
                      Block
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="bg-raised border border-line2 rounded-xl overflow-hidden">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase px-3 pt-3 pb-1">
              {active.length} with access
            </p>
            {active.map((row) => (
              <div key={row.email} className="px-3 py-3 border-t border-hair space-y-2">
                <Who row={row} />
                <div className="flex gap-1 p-1 rounded-lg bg-sunken border border-line2">
                  {ROLES.map((role) => {
                    const on = row.role === role.id
                    return (
                      <button
                        key={role.id}
                        onClick={() => void change(row, role.id)}
                        disabled={busy === row.email || on}
                        aria-pressed={on}
                        title={role.hint}
                        className={`flex-1 min-h-10 rounded-md text-xs ${
                          on ? 'bg-raised border border-line text-fg font-semibold' : 'text-faint'
                        }`}
                      >
                        {role.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </section>

          <p className="text-xs text-faint px-1">
            Anyone with a Google account can sign in; only these people can do anything. Blocking
            keeps the row so you can see who asked.
          </p>
        </>
      )}
    </div>
  )
}

function Header() {
  return (
    <div className="flex items-center gap-2">
      <Link to="/more" className="min-h-11 min-w-11 -ml-2 inline-flex items-center justify-center text-muted" aria-label="Back to More">
        <Icon name="chevron-right" size={20} className="rotate-180" />
      </Link>
      <h1 className="text-base font-semibold text-fg">Users</h1>
    </div>
  )
}

function Who({ row }: { row: UserRow }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-fg truncate">{row.name || row.email}</p>
      <p className="text-xs text-faint truncate">{row.email}</p>
    </div>
  )
}
