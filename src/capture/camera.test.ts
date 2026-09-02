import { describe, it, expect } from 'vitest'
import { squareCropRect, isTooSmall, describeMediaError } from './camera'

describe('squareCropRect', () => {
  it('centres the crop on a landscape photo', () => {
    // 4000 wide, 3000 tall: the square is 3000, offset 500 from the left.
    const r = squareCropRect(4000, 3000)
    expect(r.size).toBe(3000)
    expect(r.sx).toBe(500)
    expect(r.sy).toBe(0)
  })

  it('centres the crop on a portrait photo', () => {
    const r = squareCropRect(3000, 4000)
    expect(r.size).toBe(3000)
    expect(r.sx).toBe(0)
    expect(r.sy).toBe(500)
  })

  it('takes the whole frame when already square', () => {
    const r = squareCropRect(2000, 2000)
    expect(r).toMatchObject({ sx: 0, sy: 0, size: 2000 })
  })

  it('downscales a large photo to the 1600px target', () => {
    expect(squareCropRect(4000, 3000).out).toBe(1600)
  })

  it('never upscales a small photo, which would only inflate the upload', () => {
    // 800px source stays 800px rather than being stretched to 1600.
    expect(squareCropRect(800, 900).out).toBe(800)
  })

  it('honours a custom target', () => {
    expect(squareCropRect(4000, 4000, 1000).out).toBe(1000)
  })

  it('stays within TikTok’s 4000px ceiling', () => {
    expect(squareCropRect(8000, 8000, 9000).out).toBeLessThanOrEqual(4000)
  })

  it('returns whole pixels, since a fractional crop shifts the image', () => {
    const r = squareCropRect(1001, 1000)
    expect(Number.isInteger(r.sx)).toBe(true)
    expect(Number.isInteger(r.sy)).toBe(true)
    expect(Number.isInteger(r.out)).toBe(true)
  })

  it('rejects a zero or negative source', () => {
    expect(() => squareCropRect(0, 100)).toThrow(/Cannot crop/)
    expect(() => squareCropRect(100, -1)).toThrow(/Cannot crop/)
  })
})

describe('isTooSmall', () => {
  it('flags anything under TikTok’s 300px main-image minimum', () => {
    expect(isTooSmall(299, 1000)).toBe(true)
    expect(isTooSmall(300, 300)).toBe(false)
    expect(isTooSmall(1600, 1600)).toBe(false)
  })
})

describe('describeMediaError', () => {
  it('tells the operator how to fix a blocked permission', () => {
    const msg = describeMediaError({ name: 'NotAllowedError' }, 'microphone')
    expect(msg).toMatch(/Microphone access was blocked/)
    expect(msg).toMatch(/site settings/)
  })

  it('explains a camera already in use', () => {
    expect(describeMediaError({ name: 'NotReadableError' }, 'camera')).toMatch(/already in use/)
  })

  it('explains a missing device', () => {
    expect(describeMediaError({ name: 'NotFoundError' }, 'camera')).toMatch(/No camera was found/)
  })

  it('falls back to the underlying message rather than an empty string', () => {
    expect(describeMediaError(new Error('boom'), 'camera')).toMatch(/boom/)
  })
})
