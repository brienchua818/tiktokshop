import { describe, expect, it } from 'vitest'
import { ScriptError } from './script-api'

/**
 * How a failure is classified decides what happens to a SKU mid-broadcast, so
 * the distinctions are worth pinning:
 *
 *   - retryable        push it again unchanged
 *   - outcome unknown  ASK TikTok before calling it a failure
 *   - neither          TikTok decided; retrying burns the daily allowance
 *
 * The middle one exists because of a real SKU: the listing showed four
 * variations while the app showed the fourth as failed. The write had landed
 * and only the reply was lost.
 */
describe('ScriptError classification', () => {
  const err = (status: number, code?: string) => new ScriptError(status, 'x', code)

  describe('outcome unknown — the write may have landed', () => {
    it('treats a lost connection as unknown, not failed', () => {
      expect(err(0).isOutcomeUnknown).toBe(true)
    })

    it('treats a page where JSON was expected as unknown', () => {
      // The exact case seen in the field: the push reached Apps Script and the
      // reply came back as an error page.
      expect(err(502, 'NOT_JSON').isOutcomeUnknown).toBe(true)
    })

    it('treats a mishandled redirect as unknown', () => {
      expect(err(502, 'REDIRECT_METHOD').isOutcomeUnknown).toBe(true)
    })

    it('treats a gateway timeout as unknown', () => {
      expect(err(504).isOutcomeUnknown).toBe(true)
    })
  })

  describe('decisions — TikTok said no, so nothing landed', () => {
    it('a rejected SKU is not an unknown outcome', () => {
      // 422 is what the router returns for a refused push. Re-asking TikTok
      // about it would be pointless, and retrying costs daily allowance.
      expect(err(422).isOutcomeUnknown).toBe(false)
      expect(err(422).isRetryable).toBe(false)
    })

    it('a full listing is a decision, not an unknown outcome', () => {
      const full = err(409, 'LISTING_FULL')
      expect(full.isListingFull).toBe(true)
      expect(full.isOutcomeUnknown).toBe(false)
    })

    it('an expired sign-in is neither retryable nor unknown', () => {
      const auth = err(401)
      expect(auth.isAuthError).toBe(true)
      expect(auth.isOutcomeUnknown).toBe(false)
    })

    it('an unapproved account is its own case', () => {
      expect(err(403).isPending).toBe(true)
      expect(err(403).isOutcomeUnknown).toBe(false)
    })
  })

  describe('retryable', () => {
    it('a contended write retries itself and loses nothing', () => {
      expect(err(409, 'LISTING_BUSY').isRetryable).toBe(true)
    })

    it('a server error retries', () => {
      expect(err(500).isRetryable).toBe(true)
    })
  })
})
