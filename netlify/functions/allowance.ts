import { withAuth, json, requireParam, toResponse } from '../lib/http'
import { listingsUsedToday } from '../lib/db'
import { hasDatabase } from '../lib/store'
import { findShop } from '../lib/shops-config'

/**
 * Remaining product uploads for today.
 *
 * TikTok caps new shops at 100 a day during probation, rising to 1,000. A
 * 200-SKU stream on a fresh shop fails at item 101, so the number is surfaced
 * rather than discovered mid-broadcast.
 *
 * Without a database there is nothing counting local pushes, so the figure is
 * reported as unknown rather than as a confident zero — a wrong "1000 left"
 * is worse than no number, because it would be trusted.
 */
export default withAuth(async (request) => {
  try {
    const shopId = requireParam(request, 'shop_id')
    const shop = findShop(shopId)
    if (!shop) return json({ error: 'Unknown shop.' }, 404)

    const cap = shop.daily_listing_cap
    if (!hasDatabase()) {
      return json({ used: null, cap, remaining: null, tracked: false })
    }

    const used = await listingsUsedToday(shopId)
    return json({ used, cap, remaining: Math.max(0, cap - used), tracked: true })
  } catch (error) {
    return toResponse(error)
  }
})
