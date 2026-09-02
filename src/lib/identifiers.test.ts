import { describe, it, expect } from 'vitest'
import { parseIdentifier, formatIdentifier, nextIdentifier, buildTitle } from './identifiers'

describe('parseIdentifier', () => {
  it('parses the A1 scheme', () => {
    expect(parseIdentifier('A1')).toEqual({ prefix: 'A', seq: 1 })
    expect(parseIdentifier('B247')).toEqual({ prefix: 'B', seq: 247 })
  })

  it('uppercases the prefix so "a1" and "A1" cannot both exist', () => {
    expect(parseIdentifier('a1')).toEqual({ prefix: 'A', seq: 1 })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseIdentifier('  A9  ')).toEqual({ prefix: 'A', seq: 9 })
  })

  it('returns null for anything that would corrupt the sequence', () => {
    expect(parseIdentifier('')).toBeNull()
    expect(parseIdentifier(null)).toBeNull()
    expect(parseIdentifier(undefined)).toBeNull()
    expect(parseIdentifier('A')).toBeNull()
    expect(parseIdentifier('12')).toBeNull()
    expect(parseIdentifier('A1B')).toBeNull()
    expect(parseIdentifier('A-1')).toBeNull()
    expect(parseIdentifier('A 1')).toBeNull()
    expect(parseIdentifier('A0')).toBeNull()
  })
})

describe('formatIdentifier', () => {
  it('joins prefix and sequence', () => {
    expect(formatIdentifier('A', 1)).toBe('A1')
    expect(formatIdentifier('b', 12)).toBe('B12')
  })
})

describe('nextIdentifier', () => {
  it('starts at A1 when there is nothing to continue from', () => {
    expect(nextIdentifier([], [])).toEqual({ prefix: 'A', seq: 1 })
  })

  it('continues from SKUs already live on TikTok', () => {
    expect(nextIdentifier(['A1', 'A2', 'A3'], [])).toEqual({ prefix: 'A', seq: 4 })
  })

  it('continues from local drafts not yet pushed', () => {
    expect(nextIdentifier([], ['A1', 'A2'])).toEqual({ prefix: 'A', seq: 3 })
  })

  it('considers both sources, which is what prevents a collision', () => {
    // Listed goes to A3, drafts already reached A7. Ignoring drafts would
    // hand out A4 and collide once those drafts push.
    expect(nextIdentifier(['A1', 'A2', 'A3'], ['A6', 'A7'])).toEqual({ prefix: 'A', seq: 8 })
  })

  it('is not fooled by ordering', () => {
    expect(nextIdentifier(['A9', 'A2', 'A5'], [])).toEqual({ prefix: 'A', seq: 10 })
  })

  it('keeps the prefix of the highest entry when the stream has moved on', () => {
    expect(nextIdentifier(['A1', 'A2'], ['B1'])).toEqual({ prefix: 'B', seq: 2 })
  })

  it('ignores unparseable identifiers rather than restarting', () => {
    expect(nextIdentifier(['A1', 'JUNK', '', null], ['A2'])).toEqual({ prefix: 'A', seq: 3 })
  })

  it('honours a custom fallback prefix when there is nothing to continue', () => {
    expect(nextIdentifier([], [], 'C')).toEqual({ prefix: 'C', seq: 1 })
  })
})

describe('buildTitle', () => {
  it('leads with the identifier', () => {
    expect(
      buildTitle({ identifier: 'A1', productName: 'Ceramic Serving Bowl', includeDims: false }),
    ).toBe('A1-Ceramic Serving Bowl')
  })

  it('appends dimensions in centimetres when asked', () => {
    expect(
      buildTitle({
        identifier: 'A1',
        productName: 'Ceramic Serving Bowl',
        includeDims: true,
        dimensions: { length: '20', width: '20', height: '8' },
      }),
    ).toBe('A1-Ceramic Serving Bowl 20x20x8cm')
  })

  it('omits dimensions when any measurement is missing', () => {
    expect(
      buildTitle({
        identifier: 'A1',
        productName: 'Bowl',
        includeDims: true,
        dimensions: { length: '20', width: '', height: '8' },
      }),
    ).toBe('A1-Bowl')
  })

  it('omits dimensions when not requested even if present', () => {
    expect(
      buildTitle({
        identifier: 'A1',
        productName: 'Bowl',
        includeDims: false,
        dimensions: { length: '20', width: '20', height: '8' },
      }),
    ).toBe('A1-Bowl')
  })

  it('falls back to the identifier alone when the name is blank', () => {
    expect(buildTitle({ identifier: 'A1', productName: '   ', includeDims: false })).toBe('A1')
  })
})
