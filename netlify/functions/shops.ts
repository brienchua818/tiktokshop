import { withAuth, json } from '../lib/http'
import { listShopsForClient, listingsUsedToday } from '../lib/db'

/**
 * The shops the UI may show, labelled by brand.
 *
 * Deliberately excludes every credential column — the browser has no business
 * receiving an app secret or a TikTok token even in a form it cannot read.
 */
export default withAuth(async () => {
  const shops = await listShopsForClient()

  // Attach today's usage so the UI can warn before the daily cap bites.
  const withUsage = await Promise.all(
    shops.map(async (shop) => ({
      ...shop,
      shop_cipher: null,
      listings_used_today: await listingsUsedToday(shop.shop_id),
    })),
  )

  return json(withUsage)
})
