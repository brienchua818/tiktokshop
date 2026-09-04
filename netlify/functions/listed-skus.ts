import { withAuth, json, requireParam, toResponse } from '../lib/http'
import { credentialsFor } from '../lib/credentials'
import { call, TikTokApiError } from '../lib/tiktok-api'
import { CATEGORY_VERSION } from '../../src/lib/tiktok-rules'

/**
 * SKUs already live on TikTok for a listing.
 *
 * Feeds the self-healing identifier counter: without this, a fresh device
 * would restart at A1 and collide with everything already listed.
 */
export default withAuth(async (request) => {
  try {
    const shopId = requireParam(request, 'shop_id')
    const creds = await credentialsFor(shopId)

    const result = await call<{
      products: { id: string; title: string; skus: { seller_sku: string | null }[] }[]
    }>({
      path: '/product/202502/products/search',
      method: 'POST',
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      accessToken: creds.accessToken,
      ...(creds.shopCipher ? { shopCipher: creds.shopCipher } : {}),
      query: { page_size: 100, category_version: CATEGORY_VERSION },
      json: { status: 'ALL' },
    })

    const skus = (result.products ?? []).flatMap((product) =>
      (product.skus ?? []).map((sku) => ({ seller_sku: sku.seller_sku, title: product.title })),
    )
    return json(skus)
  } catch (error) {
    // Returning an empty list would silently reset the counter to A1 and
    // duplicate identifiers, so this failure has to be visible.
    if (error instanceof TikTokApiError) {
      return json({ error: `Could not read existing SKUs: ${error.detail}` }, 502)
    }
    return toResponse(error)
  }
})
