/**
 * SKU identifiers: "A1", "A2", "A3".
 *
 * This scheme is carried over from the app being replaced, because whoever
 * designed it had clearly run a livestream: a short, spoken-aloud identifier
 * that a person can read off a product while talking. It also happens to
 * satisfy TikTok's `seller_sku` rule, which forbids spaces.
 *
 * The parsing here is what makes the counter self-healing. Given the
 * identifiers already in use — from local drafts and from variations already
 * live on TikTok — the next one continues the sequence instead of colliding.
 */

import { PREFIX_MAX } from './tiktok-rules'

export interface ParsedIdentifier {
  prefix: string
  seq: number
}

/**
 * Parse "A12" or "HZE12" into `{ prefix, seq }`. Returns null for anything that
 * is not one to three letters followed by digits, so a hand-typed or foreign
 * SKU cannot corrupt the sequence.
 *
 * The prefix length is bounded here as well as in the input, because this is
 * what reads SKUs back from TikTok: a product carrying some other naming
 * scheme entirely — "SUPPLIER-2024-001" — must be ignored rather than
 * misparsed into a sequence the counter then tries to continue.
 */
export function parseIdentifier(value: string | null | undefined): ParsedIdentifier | null {
  if (!value) return null
  const match = new RegExp(`^([A-Za-z]{1,${PREFIX_MAX}})(\\d+)$`).exec(value.trim())
  if (!match) return null
  const seq = Number.parseInt(match[2]!, 10)
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  return { prefix: match[1]!.toUpperCase(), seq }
}

/** Format a prefix and sequence into an identifier. */
export function formatIdentifier(prefix: string, seq: number): string {
  return `${prefix.toUpperCase()}${seq}`
}

/**
 * The prefix to start the operator off with.
 *
 * Seeds the prefix input, and only that. It exists so that leaving a stream
 * and coming back does not reset a deliberately chosen prefix to "A" and
 * orphan the series already in progress — the component remounts, this reads
 * the state back off the work in play, and the operator carries on.
 *
 * Unpushed drafts are the more recent signal of intent than what is already
 * live, so they win when they contain anything parseable.
 */
export function activePrefixFrom(
  listed: readonly (string | null | undefined)[],
  drafts: readonly (string | null | undefined)[],
  fallback = 'A',
): string {
  const parse = (values: readonly (string | null | undefined)[]) =>
    values.map(parseIdentifier).filter((p): p is ParsedIdentifier => p !== null)

  const source = parse(drafts).length > 0 ? parse(drafts) : parse(listed)
  if (source.length === 0) return fallback.toUpperCase()

  // The highest-numbered one, because that is the series being worked on.
  return source.reduce((best, current) => (current.seq > best.seq ? current : best)).prefix
}

/**
 * Work out the next identifier.
 *
 * The prefix is the operator's, not inferred. It used to be read back off the
 * drafts, which made the prefix input decorative: typing "HZE" while A1–A7 sat
 * in the queue still produced A8. The input is the explicit control, so it
 * decides — `activePrefixFrom` seeds it, and after that what is typed wins.
 *
 * The NUMBER is still derived, from both sources the original app used: SKUs
 * already live on TikTok, and drafts not yet pushed. Ignoring either is how you
 * end up with two A7s.
 *
 * @param listed identifiers of variations already live on TikTok
 * @param drafts identifiers of local drafts not yet pushed
 * @param prefix the operator's chosen prefix
 */
export function nextIdentifier(
  listed: readonly (string | null | undefined)[],
  drafts: readonly (string | null | undefined)[],
  prefix = 'A',
): ParsedIdentifier {
  const active = prefix.trim().toUpperCase() || 'A'

  // Only identifiers sharing the active prefix can constrain the next number.
  // A stream that has done A1–A50 and switches to "HZE" starts at HZE1, which
  // is the point of switching.
  const highest = [...listed, ...drafts]
    .map(parseIdentifier)
    .filter((p): p is ParsedIdentifier => p !== null)
    .filter((p) => p.prefix === active)
    .reduce((max, current) => Math.max(max, current.seq), 0)

  return { prefix: active, seq: highest + 1 }
}

/**
 * Build the product title.
 *
 * The identifier leads, so the title sorts and scans in the order SKUs were
 * created — which is how the export is read back at the factory. Dimensions
 * are appended only when asked for.
 */
export function buildTitle(opts: {
  identifier: string
  productName: string
  includeDims: boolean
  dimensions?: { length: string; width: string; height: string } | null
}): string {
  const name = opts.productName.trim()
  const base = name ? `${opts.identifier}-${name}` : opts.identifier

  if (!opts.includeDims || !opts.dimensions) return base

  const { length, width, height } = opts.dimensions
  if (!length || !width || !height) return base

  // Centimetres is the only unit TikTok accepts for Singapore, so it is not
  // configurable — stating it avoids the ambiguity the old app's unit picker
  // introduced.
  return `${base} ${length}x${width}x${height}cm`
}
