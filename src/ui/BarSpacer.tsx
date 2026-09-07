/**
 * Reserves the height of a screen's own fixed bottom bar.
 *
 * The shell already pads `main` by the height of the tab bar. A screen that
 * adds a *second* fixed bar above it — the List button, the export bar — takes
 * another ~56px of the viewport that nothing accounts for, so the last row of
 * whatever is scrolling can never be scrolled clear of it. On the listing
 * screen that is the newest variation in the queue, which is the row someone
 * most wants to read.
 *
 * So a screen with its own bottom bar ends with one of these. `md:hidden`
 * because the bars are phone-only: on an iPad the same controls sit in the
 * flow and need no reservation.
 */
export default function BarSpacer() {
  return <div className="md:hidden h-14 shrink-0" aria-hidden />
}
