import { clearCookie } from '../lib/session'
import { json, methodNotAllowed } from '../lib/http'

export default async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  // Unconditional, with no session check: signing out must work even from a
  // corrupt or expired cookie, or a user can never clear a bad one.
  try {
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() })
  } catch (error) {
    console.error('[tikshop] sign-out failed', error)
    return json({ ok: true })
  }
}
