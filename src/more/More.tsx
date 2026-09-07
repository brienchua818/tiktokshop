import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type DriveLinks } from '../lib/api'
import { sessionMsLeft } from '../lib/script-api'
import type { SignedInUser } from '../types'
import Icon, { type IconName } from '../ui/Icon'
import type { ThemeChoice } from '../lib/theme'

/**
 * Everything that is not listing or orders.
 *
 * It exists because the old two-row header carried Sign out next to the shop
 * picker, in the exact spot a right thumb lands — the most destructive control
 * in the app in the easiest place to hit by accident. Moving it here bought
 * back 52 px at the top of every screen and put a deliberate two taps in front
 * of signing out.
 */
export default function More({
  user,
  theme,
  onTheme,
  onSignOut,
}: {
  user: SignedInUser & { role?: string; admin?: boolean; links?: DriveLinks }
  theme: ThemeChoice
  onTheme: (choice: ThemeChoice) => void
  onSignOut: () => void
}) {
  const [links, setLinks] = useState<DriveLinks | null>(user.links ?? null)
  const [pendingUsers, setPendingUsers] = useState<number | null>(null)

  // The links come with whoami, but a session restored from storage skipped
  // that response — so ask once rather than showing rows that go nowhere.
  useEffect(() => {
    if (links) return
    api
      .me()
      .then((me) => setLinks(me.links ?? null))
      .catch(() => setLinks(null))
  }, [links])

  // The count on the Users row. Admins only: the backend refuses the rest,
  // and a badge nobody can act on is noise.
  useEffect(() => {
    if (!user.admin) return
    api
      .users()
      .then((rows) => setPendingUsers(rows.filter((r) => r.role === 'pending').length))
      .catch(() => setPendingUsers(null))
  }, [user.admin])

  const sessionHours = Math.floor(sessionMsLeft() / 3_600_000)
  const sessionNote =
    sessionMsLeft() > 0
      ? `${user.email} · signed in for ${sessionHours > 0 ? `another ${sessionHours}h` : 'less than an hour'}`
      : user.email

  return (
    <div className="space-y-3">
      <section className="bg-raised border border-line2 rounded-xl p-3 space-y-2.5">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Appearance</p>
        <div className="flex gap-1 p-1 rounded-xl bg-sunken border border-line2" role="group" aria-label="Appearance">
          <ThemeButton current={theme} value="auto" label="Auto" icon="auto" onPick={onTheme} />
          <ThemeButton current={theme} value="day" label="Day" icon="sun" onPick={onTheme} />
          <ThemeButton current={theme} value="dark" label="Dark" icon="moon" onPick={onTheme} />
        </div>
        <p className="text-xs text-faint">
          Auto follows the phone. Day for a bright factory floor, dark for the evening stream.
          Remembered on this device.
        </p>
      </section>

      <section className="bg-raised border border-line2 rounded-xl overflow-hidden divide-y divide-hair">
        {user.admin && (
          <Row
            to="/more/users"
            icon="users"
            label="Users"
            detail={
              pendingUsers === null
                ? 'Approve, block or remove access'
                : pendingUsers > 0
                  ? `${pendingUsers} waiting for approval`
                  : 'Everyone is approved'
            }
            badge={pendingUsers ?? 0}
          />
        )}
        {links && (
          <>
            <Row href={links.sheet} icon="sheet" label="Data sheet" detail="Listings, SKUs, orders and the log" />
            <Row href={links.exports} icon="download" label="Exports folder" detail="Every purchase order, by date" />
            <Row href={links.photos} icon="image" label="Product photos" detail="Every photo taken in the app" />
          </>
        )}
        <Row to="/more/about" icon="info" label="About and error codes" detail="What a TS- code means, and what to do" />
      </section>

      <section className="bg-raised border border-line2 rounded-xl overflow-hidden">
        <button
          onClick={onSignOut}
          className="w-full flex items-center gap-3 px-3 h-14 text-left active:bg-chip"
        >
          <Icon name="sign-out" className="text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-fg">Sign out</span>
            <span className="block text-xs text-faint truncate">{sessionNote}</span>
          </span>
        </button>
      </section>
    </div>
  )
}

function ThemeButton({
  current,
  value,
  label,
  icon,
  onPick,
}: {
  current: ThemeChoice
  value: ThemeChoice
  label: string
  icon: IconName
  onPick: (choice: ThemeChoice) => void
}) {
  const on = current === value
  return (
    <button
      onClick={() => onPick(value)}
      aria-pressed={on}
      className={`flex-1 min-h-10 rounded-lg flex items-center justify-center gap-1.5 text-sm ${
        on ? 'bg-raised border border-line text-fg font-semibold' : 'text-faint'
      }`}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  )
}

/**
 * One settings row. Either goes somewhere in the app (`to`) or opens something
 * in Drive (`href`) — never neither, so there is no row that does nothing.
 */
function Row({
  to,
  href,
  icon,
  label,
  detail,
  badge = 0,
}: {
  to?: string
  href?: string
  icon: IconName
  label: string
  detail: string
  badge?: number
}) {
  const inner = (
    <>
      <Icon name={icon} className="text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg">{label}</span>
        <span className="block text-xs text-faint truncate">{detail}</span>
      </span>
      {badge > 0 && <span className="text-xs font-semibold text-warn">{badge}</span>}
      <Icon name="chevron-right" size={16} className="text-ghost" />
    </>
  )
  const shell = 'flex items-center gap-3 px-3 h-14 active:bg-chip'
  if (to) {
    return (
      <Link to={to} className={shell}>
        {inner}
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={shell}>
      {inner}
    </a>
  )
}
