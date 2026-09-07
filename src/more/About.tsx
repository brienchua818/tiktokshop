import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type DriveLinks } from '../lib/api'
import Icon from '../ui/Icon'

/**
 * What to do when the app says something went wrong.
 *
 * Every failure the backend raises carries a code like TS-EXP-13, which names
 * one line of one file. This screen is what makes that code useful to someone
 * who is not going to read the source: where the code appears, what the area
 * letters mean, and where the full list lives.
 *
 * Deliberately not a copy of all 67 codes. A list that has to be kept in step
 * by hand is a list that goes stale; the generated one in the repo is the
 * record, and this page points at it.
 */
const AREAS = [
  ['API', 'Routing, roles, the request itself'],
  ['AUTH', 'Google sign-in and who is allowed in'],
  ['EXP', 'Exports to Drive, photos in the purchase order'],
  ['LCK', 'Two writes at once'],
  ['ORD', 'Order sync and summaries'],
  ['PRD', 'Products, variations, pushes'],
  ['SHT', 'The data spreadsheet'],
  ['TT', 'Talking to TikTok'],
  ['UNC', 'Something nobody anticipated — worth reporting'],
] as const

const CODES_URL =
  'https://github.com/brienchua818/tiktokshop/blob/main/apps-script/ERROR-CODES.md'

export default function About() {
  const [links, setLinks] = useState<DriveLinks | null>(null)
  const [backend, setBackend] = useState<'checking' | 'ok' | string>('checking')

  useEffect(() => {
    api
      .me()
      .then((me) => {
        setLinks(me.links ?? null)
        setBackend('ok')
      })
      .catch((e: unknown) => setBackend(e instanceof ApiError ? e.display : String(e)))
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link to="/more" className="min-h-11 min-w-11 -ml-2 inline-flex items-center justify-center text-muted" aria-label="Back to More">
          <Icon name="chevron-right" size={20} className="rotate-180" />
        </Link>
        <h1 className="text-base font-semibold text-fg">About</h1>
      </div>

      <section className="bg-raised border border-line2 rounded-xl px-4 py-3 space-y-1">
        <p className="text-sm text-fg">TikShop</p>
        <p className="text-xs text-faint">
          Live listing and orders for HOUZE, Table Matters and Painting Matters. Built in-house.
        </p>
        <p className="text-xs text-faint">
          Backend:{' '}
          {backend === 'checking' ? (
            <span className="text-muted">checking…</span>
          ) : backend === 'ok' ? (
            <span className="text-ok">reachable</span>
          ) : (
            <span className="text-bad">{backend}</span>
          )}
        </p>
      </section>

      <section className="bg-raised border border-line2 rounded-xl px-4 py-3 space-y-2">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Error codes</p>
        <p className="text-xs text-faint">
          A failure shows its code in square brackets, like{' '}
          <span className="font-mono text-warn">[TS-EXP-13]</span>. The same code is written to the
          Log tab of the data sheet and to the backend's own log, so any one of the three is enough
          to find the cause. Send me the code and I can go straight to the line.
        </p>
        <ul className="pt-1 space-y-1">
          {AREAS.map(([area, what]) => (
            <li key={area} className="flex gap-2 text-xs">
              <span className="font-mono text-warn w-11 shrink-0">{area}</span>
              <span className="text-muted">{what}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-faint pt-1">
          A number in a message like <span className="font-mono">(TikTok 12052262)</span> is
          TikTok's own error, not ours.
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <a
            href={CODES_URL}
            target="_blank"
            rel="noreferrer"
            className="min-h-11 px-3 inline-flex items-center gap-1.5 rounded-lg border border-line text-xs text-fg2"
          >
            <Icon name="info" size={16} />
            The full list
          </a>
          {links && (
            <a
              href={links.log}
              target="_blank"
              rel="noreferrer"
              className="min-h-11 px-3 inline-flex items-center gap-1.5 rounded-lg border border-line text-xs text-fg2"
            >
              <Icon name="sheet" size={16} />
              Open the log
            </a>
          )}
        </div>
      </section>

      <section className="bg-raised border border-line2 rounded-xl px-4 py-3 space-y-2">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          Two things worth knowing
        </p>
        <p className="text-xs text-faint">
          <span className="text-fg2">A SKU is never lost.</span> It is saved on this phone first and
          pushed after, so losing signal mid-stream queues it instead of dropping it. The count on
          the Listing tab is what has not reached TikTok yet.
        </p>
        <p className="text-xs text-faint">
          <span className="text-fg2">"Reviewing" is normal.</span> TikTok re-reviews the whole
          product after every change, so a new variation is not buyable for a few minutes. It is not
          an error and there is nothing to do.
        </p>
      </section>
    </div>
  )
}
