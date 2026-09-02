import { withAuth, json, requireParam, toResponse } from '../lib/http'
import { getShop } from '../lib/db'
import { buildAuthorizeUrl } from '../lib/tiktok-auth'
import { signState } from '../lib/oauth-state'

/**
 * Start the TikTok authorise flow for one shop.
 *
 * Requires a signed-in company account: authorising a shop is not something a
 * stranger who found the URL should be able to begin.
 */
export default withAuth(async (request) => {
  try {
    const shopId = requireParam(request, 'shop_id')
    const shop = await getShop(shopId)
    if (!shop) return json({ error: 'Unknown shop.' }, 404)

    // Each shop has its own app registration, because a TikTok Custom app can
    // only be authorised by the partner account that owns it.
    //
    // Naming follows the convention already used by Sheldon Delivery API, so
    // the two projects do not drift: {PREFIX}_SERVICE_ID with PREFIX being
    // PM, HZ or TM. The shared TIKTOK_SERVICE_ID is a fallback.
    const serviceId = process.env[`${shopId}_SERVICE_ID`] ?? process.env.TIKTOK_SERVICE_ID
    if (!serviceId) {
      return json(
        { error: `No TikTok service ID configured for ${shop.brand}. Set ${shopId}_SERVICE_ID.` },
        400,
      )
    }

    return json({ url: buildAuthorizeUrl(serviceId, signState(shopId)) })
  } catch (error) {
    return toResponse(error)
  }
})
