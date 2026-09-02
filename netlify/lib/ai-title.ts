import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { validateTitle, TITLE_MIN, TITLE_MAX } from '../../src/lib/tiktok-rules'

/**
 * Photo -> product title, using Claude vision.
 *
 * Two constraints have to hold at once, and they are the whole reason this is
 * a model call rather than a template:
 *
 *   - TikTok requires 25-255 characters for Singapore. A natural title like
 *     "Ceramic Mug Blue" is 16 and gets rejected by the API.
 *   - The title must be English. TikTok refuses Chinese characters and emoji
 *     in product names outright.
 *
 * The minimum is enforced three times over: instructed in the prompt,
 * validated here with one corrective retry, and blocked in the UI. Belt and
 * braces, because the failure lands mid-livestream otherwise.
 */

const TitleSchema = z.object({
  title: z
    .string()
    .describe(
      `Product title in English, ${TITLE_MIN}-${TITLE_MAX} characters. Descriptive retail phrasing.`,
    ),
  variant_name: z
    .string()
    .describe('Short variant or colour name in English, e.g. "White Glaze". Empty if not evident.'),
  material: z.string().describe('Primary material if identifiable, e.g. "Ceramic". Empty if not.'),
  dimensions_visible: z
    .boolean()
    .describe('True only if actual measurements are legibly printed on the packaging or product.'),
  length_cm: z.string().describe('Length in centimetres if visible, else empty string.'),
  width_cm: z.string().describe('Width in centimetres if visible, else empty string.'),
  height_cm: z.string().describe('Height in centimetres if visible, else empty string.'),
})

export type TitleResult = z.infer<typeof TitleSchema>

/**
 * The instruction is deliberately explicit about *how* to reach 25 characters,
 * because a model told only "at least 25" tends to pad with filler adjectives.
 * Naming the useful attributes gets a title that reads like a product listing
 * rather than a caption.
 */
const SYSTEM_PROMPT = `You write product titles for a TikTok Shop in Singapore selling homeware, tableware, rugs and home fragrance.

Hard requirements, enforced by the TikTok API:
- The title MUST be between ${TITLE_MIN} and ${TITLE_MAX} characters. Titles under ${TITLE_MIN} characters are rejected outright.
- English only. Never use Chinese characters, other non-Latin scripts, or emoji.
- No HTML entities, no control characters, and never repeat a character more than nine times.

To reach ${TITLE_MIN} characters naturally, describe the product concretely rather than padding with adjectives. Combine, in this order of preference: material, product type, distinguishing feature, colour or finish, and capacity or size when visible. For example "Ceramic Serving Bowl White Glaze 20cm" rather than "Nice Beautiful Lovely Bowl".

Write British English. Use plain retail phrasing a shopper would search for. Do not invent measurements, brand names, or certifications you cannot see.`

let cached: Anthropic | undefined

function client(): Anthropic {
  if (cached) return cached
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set.')
  }
  cached = new Anthropic()
  return cached
}

export interface TitleRequest {
  /** Publicly reachable image URL — a small Cloudinary derivative, not the full photo. */
  imageUrl: string
  /** Anything the operator already typed or said, to steer the title. */
  hint?: string
}

/**
 * Ask for a title, then verify it. A short or non-English title is sent back
 * once with the specific problem named, which is far more reliable than
 * re-rolling the same prompt and hoping.
 */
export async function generateTitle(request: TitleRequest): Promise<TitleResult> {
  const first = await askForTitle(request)
  const violations = validateTitle(first.title)
  if (violations.length === 0) return first

  const retry = await askForTitle(request, {
    previousTitle: first.title,
    problems: violations.map((v) => v.message),
  })

  // If the retry still fails we return it anyway rather than throwing: the UI
  // blocks the push and lets the operator edit, which beats losing the photo
  // and the model's other useful fields.
  return retry
}

async function askForTitle(
  request: TitleRequest,
  correction?: { previousTitle: string; problems: string[] },
): Promise<TitleResult> {
  const instruction = correction
    ? `Your previous title was "${correction.previousTitle}" (${correction.previousTitle.length} characters). It was rejected:
${correction.problems.map((p) => `- ${p}`).join('\n')}

Write a corrected title. If it was too short, add genuine detail about material, type, finish or size — do not pad with filler words.`
    : request.hint
      ? `Describe this product for a listing. The person photographing it said: "${request.hint}". Use that to inform the title where it is consistent with the photo.`
      : 'Describe this product for a listing.'

  const response = await client().messages.parse({
    model: 'claude-opus-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: request.imageUrl } },
          { type: 'text', text: instruction },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(TitleSchema) },
  })

  const parsed = response.parsed_output
  if (!parsed) {
    throw new Error('Claude returned no parseable title. The photo may be unreadable.')
  }
  return parsed
}
