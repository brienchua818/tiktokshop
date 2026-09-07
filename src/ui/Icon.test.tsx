import { describe, expect, it } from 'vitest'
import Icon, { type IconName } from './Icon'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Icons are drawn, so a typo in a path is silent — it renders an empty or
 * mangled glyph rather than throwing. These assert the two things that would
 * ship broken: every name draws something, and the drawing inherits the
 * control's colour instead of hardcoding one.
 */
const NAMES: IconName[] = [
  'camera', 'mic', 'image', 'sparkle', 'refresh', 'chevron-down', 'chevron-right',
  'list', 'receipt', 'dots', 'calendar', 'sync', 'download', 'sun', 'moon', 'auto',
  'users', 'sign-out', 'sheet', 'info', 'close', 'trash', 'plus', 'check', 'warning',
]

describe('Icon', () => {
  it.each(NAMES)('%s draws at least one path', (name) => {
    const html = renderToStaticMarkup(<Icon name={name} />)
    expect(html).toMatch(/<path d="M/)
  })

  it('takes its colour from the control around it', () => {
    const html = renderToStaticMarkup(<Icon name="camera" />)
    expect(html).toContain('stroke="currentColor"')
    expect(html).not.toMatch(/stroke="#|fill="#/)
  })

  it('is hidden from screen readers, because the control carries the label', () => {
    expect(renderToStaticMarkup(<Icon name="close" />)).toContain('aria-hidden="true"')
  })

  it('splits a multi-segment path rather than emitting one broken d', () => {
    const html = renderToStaticMarkup(<Icon name="list" />)
    expect(html.match(/<path /g)).toHaveLength(3)
  })
})
