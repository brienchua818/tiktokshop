// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { apply, isThemeChoice, readChoice, resolve, store } from './theme'

describe('theme choice', () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('follows the phone by default, and after junk in storage', () => {
    expect(readChoice()).toBe('auto')
    localStorage.setItem('tikshop.theme', 'lilac')
    expect(readChoice()).toBe('auto')
  })

  it('remembers a choice per device', () => {
    store('day')
    expect(readChoice()).toBe('day')
    store('dark')
    expect(readChoice()).toBe('dark')
  })

  it('resolves auto from the phone, and a fixed choice regardless of it', () => {
    expect(resolve('auto', true)).toBe('dark')
    expect(resolve('auto', false)).toBe('day')
    expect(resolve('day', true)).toBe('day')
    expect(resolve('dark', false)).toBe('dark')
  })

  it('marks day on the root and leaves dark as the absence of the attribute', () => {
    apply('day')
    expect(document.documentElement.getAttribute('data-theme')).toBe('day')
    apply('dark')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('moves the status-bar colour with the palette', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.append(meta)
    apply('day')
    expect(meta.getAttribute('content')).toBe('#f4f4f2')
    apply('dark')
    expect(meta.getAttribute('content')).toBe('#0f0f0f')
    meta.remove()
  })

  it('only accepts the three choices', () => {
    expect(isThemeChoice('auto')).toBe(true)
    expect(isThemeChoice('day')).toBe(true)
    expect(isThemeChoice('dark')).toBe(true)
    expect(isThemeChoice('light')).toBe(false)
    expect(isThemeChoice(null)).toBe(false)
  })
})
