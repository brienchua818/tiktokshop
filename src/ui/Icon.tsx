/**
 * The app's icons, drawn rather than typed.
 *
 * Emoji and dingbats were the old shortcut (`↻`, `✕`), and they render
 * differently on every phone, cannot be recoloured, and sit off the baseline
 * next to text. These are stroke SVGs on a 24-grid: one weight, one join, and
 * `currentColor` so a control's colour carries into its icon.
 */
export type IconName =
  | 'camera'
  | 'mic'
  | 'image'
  | 'sparkle'
  | 'refresh'
  | 'chevron-down'
  | 'chevron-right'
  | 'list'
  | 'receipt'
  | 'dots'
  | 'calendar'
  | 'sync'
  | 'download'
  | 'sun'
  | 'moon'
  | 'auto'
  | 'users'
  | 'sign-out'
  | 'sheet'
  | 'info'
  | 'close'
  | 'trash'
  | 'plus'
  | 'check'
  | 'warning'

const PATHS: Record<IconName, string> = {
  camera: 'M4 8h3l1.5-2h7L17 8h3v11H4z M15.2 13a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0',
  mic: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0z M5 11a7 7 0 0 0 14 0 M12 18v3 M9 21h6',
  image: 'M3.5 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z M10.6 10a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0 M20 16l-5-5-7 8',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v5h-5',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  list: 'M4 7h16 M4 12h16 M4 17h16',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  dots: 'M6 12h.01 M12 12h.01 M18 12h.01',
  calendar: 'M3.5 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z M3.5 10h17 M8 3v4 M16 3v4',
  sync: 'M4 12a8 8 0 0 1 13.7-5.7 M20 12a8 8 0 0 1-13.7 5.7 M18 3v4h-4 M6 21v-4h4',
  download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  auto: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 3v18',
  users: 'M12.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0 M2.5 20a6.5 6.5 0 0 1 13 0 M19.5 9a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M15.5 14.5a5 5 0 0 1 6 5',
  'sign-out': 'M10 4H5v16h5 M14 8l4 4-4 4 M18 12H9',
  sheet: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M4 9h16 M4 15h16 M10 3v18',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v5 M12 8h.01',
  close: 'M6 6l12 12 M18 6L6 18',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 11v6 M14 11v6',
  plus: 'M12 5v14 M5 12h14',
  check: 'M5 12l4 4L19 7',
  warning: 'M12 4l9 16H3z M12 10v4 M12 17h.01',
}

export default function Icon({
  name,
  size = 20,
  className = '',
}: {
  name: IconName
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`block shrink-0 ${className}`}
    >
      {PATHS[name]
        .split(' M')
        .map((segment, index) => (
          <path key={index} d={index === 0 ? segment : `M${segment}`} />
        ))}
    </svg>
  )
}
