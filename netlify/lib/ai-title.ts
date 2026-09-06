import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { PublicError } from './http'
import {
  validateTitle,
  validateVariantName,
  TITLE_MIN,
  TITLE_MAX,
  VALUE_NAME_MAX,
} from '../../src/lib/tiktok-rules'

/**
 * Photo -> text, using Claude vision.
 *
 * Two different jobs, because a livestream needs two different pieces of text:
 *
 *   - a **variant name** for each SKU, which is the hot path. A stream is one
 *     TikTok product and every SKU is a variation of it, so what each photo
 *     needs is the short phrase that distinguishes THIS piece from the others
 *     on the same listing — not another product title.
 *   - a **product title** for the listing itself, needed once per stream.
 *
 * They have different rules and must not be conflated. A title floors at 25
 * characters; a variant name has no minimum and caps at 50. Reusing the title
 * validator on variant names rejected every short one.
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

const VariantSchema = z.object({
  variant_name: z
    .string()
    .describe(
      `Short English name distinguishing this piece from others in the same listing, at most ${VALUE_NAME_MAX} characters. e.g. "Blue Reactive Glaze Mug".`,
    ),
  material: z.string().describe('Primary material if identifiable, e.g. "Ceramic". Empty if not.'),
})

export type VariantResult = z.infer<typeof VariantSchema>

/**
 * The variant instruction is a different job from the title one, and saying so
 * matters: asked for "a title" the model writes a full retail title, which is
 * both too long for a 50-character field and redundant against the listing it
 * sits under.
 */
const VARIANT_SYSTEM_PROMPT = `You name individual variations of a product for a TikTok Shop in Singapore selling homeware, tableware, rugs and home fragrance.

The shop lists a whole factory run as ONE product with many variations. Your job is to name the ONE piece in the photo so a buyer can pick it out from the others in the same listing, and so the host can call it out on a live broadcast.

Hard requirements, enforced by the TikTok API:
- At most ${VALUE_NAME_MAX} characters. Shorter is better — aim for two to five words.
- English only. Never use Chinese characters, other non-Latin scripts, or emoji.
- No HTML entities, no control characters, and never repeat a character more than nine times.

Name what makes THIS piece different: colour, finish, pattern, shape, or size. Do not repeat the listing's product name back. Do not write a sentence, a full retail title, or marketing copy.

Good: "Blue Reactive Glaze Mug", "Matte Black Side Plate", "Speckled Bowl 20cm".
Bad: "Beautiful Premium Quality Ceramic Mug For Home Use" (too long, no distinguishing detail).

Write British English. Do not invent measurements, brands or materials you cannot see.`

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
    // Public on purpose: it names a deployment fault nobody using the app can
    // fix, which is exactly what they need to be told rather than left to
    // retry against.
    throw new PublicError(
      'The AI service is not configured on this deployment (no API key). Nothing you can fix from here — tell Brien.',
      503,
    )
  }
  // An org-level API key is not tied to a workspace, and every request made
  // with one has to name the workspace itself — otherwise the API refuses with
  // a 400 that says so. A key created inside a workspace carries that already
  // and needs nothing here, which is why this is optional rather than
  // required: both kinds of key work, and neither needs a code change to
  // switch between.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim()
  cached = new Anthropic(
    workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {},
  )
  return cached
}

export interface TitleRequest {
  image: ImageSource
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

/**
 * The photo, either as a URL Claude can fetch or as inline bytes.
 *
 * Inline is the normal path now: the Apps Script backend holds the photo and
 * there is no public URL for it unless Cloudinary is configured, which it is
 * not required to be.
 */
export type ImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; mediaType: InlineMediaType; data: string }

/**
 * The image types Claude accepts inline.
 *
 * Narrowed to a literal union rather than `string` because the SDK's own type
 * is a union — and the app only ever produces JPEG anyway, since the camera
 * encodes to it deliberately to sidestep iPhone HEIC.
 */
export type InlineMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/** Claude's own shape for whichever source was given. */
function imageBlock(image: ImageSource): Anthropic.ImageBlockParam {
  return image.kind === 'url'
    ? { type: 'image', source: { type: 'url', url: image.url } }
    : { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }
}

export interface VariantRequest {
  image: ImageSource
  /**
   * The listing's product title.
   *
   * Passed so the variant name distinguishes rather than repeats: without it
   * a photo of a mug on a "Katrin BJ ceramic run" listing comes back as
   * "Ceramic Mug", which tells a buyer nothing they did not already know.
   */
  productName?: string
  /** Anything the operator already typed or said, to steer the answer. */
  hint?: string
}

/**
 * Ask for a variant name, then verify it. One corrective retry naming the
 * specific problem, for the same reason the title path does it: re-rolling the
 * same prompt and hoping is markedly less reliable.
 */
export async function generateVariantName(request: VariantRequest): Promise<VariantResult> {
  const first = await askForVariant(request)
  const violations = validateVariantName(first.variant_name)
  if (violations.length === 0) return first

  return askForVariant(request, {
    previous: first.variant_name,
    problems: violations.map((v) => v.message),
  })
}

async function askForVariant(
  request: VariantRequest,
  correction?: { previous: string; problems: string[] },
): Promise<VariantResult> {
  const context = request.productName
    ? `This piece is being added to a listing called "${request.productName}". Name what makes it different from the others on that listing.`
    : 'Name this piece so a buyer can pick it out from similar ones.'

  const instruction = correction
    ? `Your previous answer was "${correction.previous}" (${correction.previous.length} characters). It was rejected:
${correction.problems.map((p) => `- ${p}`).join('\n')}

Write a corrected name. If it was too long, cut adjectives before you cut distinguishing detail.`
    : request.hint
      ? `${context} The person photographing it said: "${request.hint}". Use that where it is consistent with the photo.`
      : context

  const response = await client().messages.parse({
    model: 'claude-opus-5',
    // Thinking is on by default on this model, and thinking tokens come out of
    // max_tokens. At 1024 a moment's deliberation could exhaust the budget
    // before the structured answer was written — which surfaces as no parsed
    // output, indistinguishable from a photo the model could not read. The
    // answer is a dozen words; the headroom is for the reasoning in front of it.
    max_tokens: 4096,
    system: VARIANT_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [imageBlock(request.image), { type: 'text', text: instruction }],
      },
    ],
    // Deliberately the minimum request that can work: model, tokens, system,
    // content, format. A 400 is being chased and every optional field is a
    // suspect, so `effort` — an optimisation, not a requirement — is out until
    // the call succeeds. It can come back once there is a baseline to compare
    // against.
    output_config: { format: zodOutputFormat(VariantSchema) },
  })

  const parsed = response.parsed_output
  if (!parsed) {
    throw new PublicError(
      'Could not read a name from that photo. Try a clearer shot, or type the name.',
    )
  }
  return parsed
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
    // As above: thinking shares this budget, so it needs room beyond the answer.
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: [imageBlock(request.image), { type: 'text', text: instruction }],
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
