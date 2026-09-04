import { withAuth, json } from '../lib/http'
import { SHOPS } from '../lib/shops-config'
import { isAuthorised } from '../lib/credentials'

/**
 * The shops the UI may show, labelled by brand.
 *
 * Served from configuration rather than a table, so the app works with nothing
 * provisioned. Deliberately excludes every credential — the browser has no
 * business receiving an app secret or a TikTok token even in a form it cannot
 * read.
 */
export default withAuth(async () => {
  const shops = await Promise.all(
    SHOPS.map(async (shop) => ({
      shop_id: shop.shop_id,
      brand: shop.brand,
      tiktok_handle: shop.tiktok_handle,
      entity: shop.entity,
      shop_cipher: null,
      authorised: await isAuthorised(shop.shop_id),
      daily_listing_cap: shop.daily_listing_cap,
      listings_used_today: 0,
    })),
  )
  return json(shops)
})
