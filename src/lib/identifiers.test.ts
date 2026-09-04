import { describe, it, expect } from 'vitest'
import { activePrefixFrom, parseIdentifier, formatIdentifier, nextIdentifier, buildTitle } from './identifiers'

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

  it('uses the prefix it is given, not one inferred from the work', () => {
    // The prefix input is the operator's explicit control. Inferring it from
    // the drafts made that input decorative — typing a new prefix while A1-A7
    // sat in the queue still produced A8.
    expect(nextIdentifier(['A1', 'A2'], ['B1'], 'B')).toEqual({ prefix: 'B', seq: 2 })
    expect(nextIdentifier(['A1', 'A2'], ['B1'], 'A')).toEqual({ prefix: 'A', seq: 3 })
  })

  it('starts a switched-to prefix at 1, however high the old series went', () => {
    // A stream that has done A1-A50 and switches to HZE starts at HZE1. That
    // is the entire point of switching.
    const listed = Array.from({ length: 50 }, (_, i) => `A${i + 1}`)
    expect(nextIdentifier(listed, [], 'HZE')).toEqual({ prefix: 'HZE', seq: 1 })
  })

  it('continues a three-letter series from its own highest number', () => {
    expect(nextIdentifier(['HZE1', 'HZE2'], ['HZE7'], 'HZE')).toEqual({ prefix: 'HZE', seq: 8 })
  })

  it('is not confused by another prefix sharing the same numbers', () => {
    expect(nextIdentifier(['A1', 'A2', 'A3'], ['TMX1'], 'TMX')).toEqual({ prefix: 'TMX', seq: 2 })
  })

  it('upper-cases and trims whatever prefix it is handed', () => {
    expect(nextIdentifier([], [], ' hze ')).toEqual({ prefix: 'HZE', seq: 1 })
  })

  it('falls back to A rather than producing a prefixless identifier', () => {
    expect(nextIdentifier([], [], '')).toEqual({ prefix: 'A', seq: 1 })
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


/**
 * Seeding the prefix input.
 *
 * The prefix is the operator's once they touch it, but it has to start
 * somewhere — and starting at "A" every time would reset a deliberately chosen
 * prefix whenever the screen remounted, orphaning the series in progress.
 */
describe('activePrefixFrom', () => {
  it('defaults to A when there is nothing to go on', () => {
    expect(activePrefixFrom([], [])).toBe('A')
  })

  it('honours an explicit fallback', () => {
    expect(activePrefixFrom([], [], 'C')).toBe('C')
  })

  it('recovers the prefix from what is already live', () => {
    expect(activePrefixFrom(['HZE1', 'HZE2'], [])).toBe('HZE')
  })

  it('lets unpushed drafts win, as the more recent signal of intent', () => {
    // The operator switched to B and queued one. Coming back to the screen
    // must not drop them into A again.
    expect(activePrefixFrom(['A1', 'A2'], ['B1'])).toBe('B')
  })

  it('takes the highest-numbered series when drafts mix prefixes', () => {
    expect(activePrefixFrom([], ['A1', 'B4'])).toBe('B')
  })

  it('ignores junk rather than falling back', () => {
    expect(activePrefixFrom(['SUPPLIER-2024-001', ''], ['HZE3'])).toBe('HZE')
  })

  it('upper-cases what it finds', () => {
    expect(activePrefixFrom(['hze1'], [])).toBe('HZE')
  })

  it('together with nextIdentifier, continues rather than collides', () => {
    // The pairing the screen actually uses.
    const listed = ['A1', 'A2']
    const drafts = ['B1']
    const prefix = activePrefixFrom(listed, drafts)
    expect(nextIdentifier(listed, drafts, prefix)).toEqual({ prefix: 'B', seq: 2 })
  })
})
