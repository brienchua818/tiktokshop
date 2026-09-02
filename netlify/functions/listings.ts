import { withAuth, json, requireParam, toResponse, methodNotAllowed } from '../lib/http'
import { listListings, addListing } from '../lib/db'

/** Factory streams for a shop: list them, or add one by TikTok listing ID. */
export default withAuth(async (request) => {
  try {
    if (request.method === 'GET') {
      return json(await listListings(requireParam(request, 'shop_id')))
    }

    if (request.method === 'POST') {
      const body = (await request.json()) as { shop_id?: string; listing_id?: string }
      if (!body.shop_id || !body.listing_id) {
        return json({ error: 'shop_id and listing_id are both required.' }, 400)
      }
      // Digits only. Catching a pasted URL here beats a confusing TikTok error.
      if (!/^\d{6,}$/.test(body.listing_id)) {
        return json({ error: 'listing_id should be digits only.' }, 400)
      }
      return json(await addListing(body.shop_id, body.listing_id))
    }

    return methodNotAllowed('GET, POST')
  } catch (error) {
    return toResponse(error)
  }
})
