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

export interface ParsedIdentifier {
  prefix: string
  seq: number
}

/**
 * Parse "A12" into `{ prefix: 'A', seq: 12 }`. Returns null for anything that
 * is not letters followed by digits, so a hand-typed SKU cannot corrupt the
 * sequence.
 */
export function parseIdentifier(value: string | null | undefined): ParsedIdentifier | null {
  if (!value) return null
  const match = /^([A-Za-z]+)(\d+)$/.exec(value.trim())
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
 * Work out the next identifier from everything already in play.
 *
 * Considers identifiers from both sources the original app used — SKUs already
 * listed on TikTok, and drafts not yet pushed — because ignoring either is how
 * you end up with two A7s. Falls back to A1 when there is nothing to continue
 * from.
 *
 * @param listed identifiers of variations already live on TikTok
 * @param drafts identifiers of local drafts not yet pushed
 */
export function nextIdentifier(
  listed: readonly (string | null | undefined)[],
  drafts: readonly (string | null | undefined)[],
  fallbackPrefix = 'A',
): ParsedIdentifier {
  const parsed = [...listed, ...drafts]
    .map(parseIdentifier)
    .filter((p): p is ParsedIdentifier => p !== null)

  if (parsed.length === 0) {
    return { prefix: fallbackPrefix.toUpperCase(), seq: 1 }
  }

  // Which prefix is in play matters as much as which number. If the operator
  // has started a "B" series, the next SKU is a B even though the "A" numbers
  // are higher. Unpushed drafts are the more recent signal of intent, so they
  // decide the prefix whenever they contain one.
  const draftsParsed = drafts.map(parseIdentifier).filter((p): p is ParsedIdentifier => p !== null)
  const source = draftsParsed.length > 0 ? draftsParsed : parsed
  const activePrefix = source.reduce((best, current) => (current.seq > best.seq ? current : best))
    .prefix

  // Then continue from the highest number used for that prefix in EITHER
  // source. Considering only one of them is how two SKUs end up sharing an
  // identifier once the drafts push.
  const highestForPrefix = parsed
    .filter((p) => p.prefix === activePrefix)
    .reduce((max, current) => Math.max(max, current.seq), 0)

  return { prefix: activePrefix, seq: highestForPrefix + 1 }
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
