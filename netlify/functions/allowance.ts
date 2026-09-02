import { withAuth, json, requireParam, toResponse } from '../lib/http'
import { getShop, listingsUsedToday } from '../lib/db'

/**
 * Remaining product uploads for today.
 *
 * TikTok caps new shops at 100 a day during probation, rising to 1,000. A
 * 200-SKU stream on a fresh shop fails at item 101, so the number is surfaced
 * rather than discovered mid-broadcast.
 */
export default withAuth(async (request) => {
  try {
    const shopId = requireParam(request, 'shop_id')
    const shop = await getShop(shopId)
    if (!shop) return json({ error: 'Unknown shop.' }, 404)

    const used = await listingsUsedToday(shopId)
    const cap = shop.daily_listing_cap
    return json({ used, cap, remaining: Math.max(0, cap - used) })
  } catch (error) {
    return toResponse(error)
  }
})
