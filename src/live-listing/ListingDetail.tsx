import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { activePrefixFrom, formatIdentifier, nextIdentifier } from '../lib/identifiers'
import {
  validateVariantName,
  validatePrice,
  validateStock,
  validateWeight,
  variantValueName,
  cleanPrefix,
  DEFAULT_WEIGHT_KG,
  DEFAULT_DIMENSIONS,
  VALUE_NAME_MAX,
  PREFIX_MAX,
} from '../lib/tiktok-rules'
import { toBase64 } from '../lib/bytes'
import { allDrafts, enqueue, removeDraft } from '../offline/queue'
import type { QueuedDraft } from '../offline/queue'
import type { Draft, Listing, Shop } from '../types'
import CameraCapture from './CameraCapture'
import VoiceCapture from './VoiceCapture'
import DraftQueue from './DraftQueue'
import BulkAdd from './BulkAdd'

/**
 * Build SKUs against one factory stream.
 *
 * This is the screen used one-handed, standing in a factory, while a
 * livestream runs. Everything here is arranged around that: the identifier is
 * allocated for you, the photo and voice do the typing, and nothing is lost if
 * the connection drops.
 */
export default function ListingDetail({
  shop,
  listing,
  onBack,
  onQueueChange,
}: {
  shop: Shop
  listing: Listing
  onBack: () => void
  onQueueChange: () => void
}) {
  // The operator's choice, and authoritative once made. Seeded from the work
  // already in play so that leaving a stream and coming back does not reset a
  // deliberately chosen prefix and orphan the series in progress.
  const [prefix, setPrefix] = useState('A')
  const [prefixSeeded, setPrefixSeeded] = useState(false)
  const [listedSkus, setListedSkus] = useState<string[]>([])
  const [drafts, setDrafts] = useState<QueuedDraft[]>([])
  const [allowance, setAllowance] = useState<{
    used: number | null
    cap: number
    remaining: number | null
  } | null>(null)

  const refreshDrafts = useCallback(async () => {
    const all = await allDrafts().catch(() => [] as QueuedDraft[])
    setDrafts(all.filter((d) => d.listing_id === listing.listing_id))
    onQueueChange()
  }, [listing.listing_id, onQueueChange])

  useEffect(() => {
    void refreshDrafts()
  }, [refreshDrafts])

  // Variations already live on TikTok. Needed so the counter continues the
  // sequence instead of restarting at A1 on a fresh device.
  useEffect(() => {
    api
      .listedSkus(shop.shop_id, listing.listing_id)
      .then((rows) => setListedSkus(rows.map((r) => r.seller_sku ?? r.title ?? '')))
      .catch(() => setListedSkus([]))
  }, [shop.shop_id, listing.listing_id])

  useEffect(() => {
    api
      .listingAllowance(shop.shop_id)
      .then(setAllowance)
      .catch(() => setAllowance(null))
  }, [shop.shop_id])

  const draftIdentifiers = useMemo(() => drafts.map((d) => d.identifier), [drafts])

  // Seed the prefix once, from whatever is already in play. Only once: after
  // that the input is the operator's and must not be overwritten by data
  // arriving late, which would silently change the prefix under their hands.
  useEffect(() => {
    if (prefixSeeded) return
    if (listedSkus.length === 0 && draftIdentifiers.length === 0) return
    setPrefix(activePrefixFrom(listedSkus, draftIdentifiers))
    setPrefixSeeded(true)
  }, [prefixSeeded, listedSkus, draftIdentifiers])

  // The next identifier: the prefix is the operator's, the NUMBER considers
  // both what is live and what is queued — ignoring either is how two SKUs end
  // up sharing an identifier.
  const next = useMemo(
    () => nextIdentifier(listedSkus, draftIdentifiers, prefix),
    [listedSkus, draftIdentifiers, prefix],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-gray-500 hover:text-white px-1" aria-label="Back">
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-mono text-cyan-400 truncate">{listing.listing_id}</p>
          <p className="text-sm text-white font-medium truncate">
            {listing.product_name ?? shop.brand}
          </p>
        </div>
      </div>

      {/* The daily cap is surfaced before it bites. New shops are limited to
          100 uploads a day, which a 200-SKU stream would hit at item 101. */}
      {/* Only warn on a number we actually know. Without server-side push
          tracking the figure is null, and inventing a confident one would be
          worse than showing none — it would be trusted. */}
      {allowance && allowance.remaining !== null && allowance.remaining <= 25 && (
        <p
          className={`text-sm rounded-lg px-4 py-2 border ${
            allowance.remaining === 0
              ? 'bg-red-500/10 border-red-500/30 text-red-300'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          }`}
        >
          {allowance.remaining === 0
            ? `${shop.brand} has used its ${allowance.cap} product uploads for today. Further pushes will be rejected until midnight Singapore time.`
            : `${allowance.remaining} of ${shop.brand}'s ${allowance.cap} daily product uploads left.`}
        </p>
      )}

      <IdentifierSettings prefix={prefix} onPrefix={setPrefix} nextIdentifier={formatIdentifier(next.prefix, next.seq)} />

      {/* One column on a phone, two on an iPad. See `.listing-columns` in
          index.css — the breakpoint is on width AND height, because a
          landscape phone is wide enough for two columns and nowhere near tall
          enough to use them.

          Not decoration. On a phone the queue sits below the form and you
          scroll to it; on an iPad there is horizontal room going spare, and
          putting the queue beside the form means watching SKUs land while
          adding the next one. During a stream that is the difference between
          noticing a rejection immediately and finding six at the end. */}
      <div className="listing-columns">
        <div className="space-y-4 min-w-0">
          <SkuForm
            shop={shop}
            listing={listing}
            identifier={formatIdentifier(next.prefix, next.seq)}
            onSaved={refreshDrafts}
          />

          <BulkAdd
            shop={shop}
            listing={listing}
            startIdentifier={formatIdentifier(next.prefix, next.seq)}
            onSaved={refreshDrafts}
          />
        </div>

        <div className="listing-queue min-w-0">
          <DraftQueue
            drafts={drafts}
            listingId={listing.listing_id}
            onChanged={refreshDrafts}
            onDelete={async (id) => {
              await removeDraft(id)
              await refreshDrafts()
            }}
          />
        </div>
      </div>
    </div>
  )
}

function IdentifierSettings({
  prefix,
  onPrefix,
  nextIdentifier: next,
}: {
  prefix: string
  onPrefix: (value: string) => void
  nextIdentifier: string
}) {
  return (
    <div className="bg-raised border border-white/8 rounded-xl p-4 space-y-3">
      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Identifier</p>
      {/* A two-row grid rather than two stacked blocks side by side.

          Bottom-aligning the blocks looked wrong for a reason: the left one is
          a label plus a 44px input and the right is a label plus a line of
          text, so aligning their BOTTOMS pushed "Next SKU" forty pixels below
          "Prefix". The grid puts the two labels in one row and the two values
          in another, so both line up whatever their heights. */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1">
        <label htmlFor="prefix" className="text-xs text-gray-400">
          Prefix
        </label>
        <p className="text-xs text-gray-500">Next SKU</p>

        <input
          id="prefix"
          value={prefix}
          onChange={(e) => onPrefix(cleanPrefix(e.target.value))}
          // maxLength as well as the slice in cleanPrefix: the attribute stops
          // the keystroke, which means no cursor jump, and the slice catches a
          // paste or an autofill that bypasses it.
          maxLength={PREFIX_MAX}
          // The value is upper-cased on every keystroke, so the on-screen
          // keyboard should offer capitals to match — otherwise iOS shows a
          // lowercase keyboard while capitals appear in the field.
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="prefix-help"
          className="w-24 bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono uppercase tracking-widest outline-none focus:border-accent"
        />
        {/* Derived, not typed. The old app let you set the next number by
            hand, which is one more thing to get wrong mid-stream. */}
        <p className="text-lg font-mono text-identifier leading-none">{next}</p>
      </div>
      <p id="prefix-help" className="text-xs text-gray-600">
        Up to {PREFIX_MAX} letters, capitals. Continues from what is already listed and
        queued, so it cannot repeat.
      </p>
    </div>
  )
}

function SkuForm({
  shop,
  listing,
  identifier,
  onSaved,
}: {
  shop: Shop
  listing: Listing
  identifier: string
  onSaved: () => Promise<void>
}) {
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  // No product-name field, deliberately. A stream is ONE TikTok product and
  // every SKU is a variation of it, so the product title belongs to the
  // listing and is set once — asking for it per SKU invited 200 slightly
  // different titles for one factory run.
  const [variant, setVariant] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  // The photo, base64-encoded once when it is taken. Encoding here rather
  // than at push time means the cost is paid while the operator is still
  // framing the next product, not while they are waiting for a queue to drain.
  const [photoBase64, setPhotoBase64] = useState<string | null>(null)
  const [busy, setBusy] = useState<'' | 'uploading' | 'naming' | 'saving'>('')
  const [error, setError] = useState('')
  const objectUrl = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    },
    [],
  )

  // What the buyer will actually see in the variant picker. The identifier
  // leads it because that is the shared vocabulary of the broadcast — the host
  // says "A7 is the blue one" and the buyer looks for A7.
  const valueName = variantValueName(identifier, variant)
  const variantProblems = variant ? validateVariantName(valueName) : []

  // The product title comes from the listing, unchanged per SKU.
  const productTitle = listing.product_name ?? shop.brand

  async function acceptPhoto(blob: Blob) {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = URL.createObjectURL(blob)
    setPhoto(blob)
    setPhotoUrl(objectUrl.current)
    setPhotoBase64(null)
    setError('')

    // Encoded immediately, not uploaded. Nothing leaves the device until the
    // SKU is saved, so a photo taken with no signal is not a failure — it is
    // just a photo, waiting with the rest of the draft.
    setBusy('uploading')
    try {
      setPhotoBase64(await toBase64(blob))
    } catch (e: unknown) {
      setError(`Could not read the photo from this device: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  async function fillFromPhoto() {
    if (!photoBase64) {
      setError('The photo is still being read. Try again in a moment.')
      return
    }
    setBusy('naming')
    setError('')
    try {
      // The listing's title goes along so the answer distinguishes this piece
      // rather than repeating what the listing already says.
      const result = await api.variantFromPhoto(photoBase64, productTitle, variant || undefined)
      if (result.variant_name) setVariant(result.variant_name)
      // Said plainly rather than left for the operator to discover on save.
      if (result.problems.length > 0) setError(result.problems[0]!)
    } catch (e: unknown) {
      setError(`Could not read the photo: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  function applyVoice(fields: {
    name?: string
    variant?: string
    price?: string
    stock?: number
    weightKg?: string
    dimensions?: { length: string; width: string; height: string }
  }) {
    // Only overwrite what was actually heard, so speaking a price does not
    // wipe a name already typed.
    //
    // Both spoken name fields land on the variant, because there is nowhere
    // else for them to go: describing the item on air IS describing the
    // variation. `variant` wins when the model returned both, since it is the
    // more specific of the two.
    const spokenName = fields.variant || fields.name
    if (spokenName) setVariant(spokenName)
    if (fields.price) setPrice(fields.price)
    if (fields.stock !== undefined) setStock(String(fields.stock))
    // Spoken weight and dimensions are deliberately ignored: both are fixed
    // declarations now, so accepting them here would silently reintroduce a
    // field nobody can see or correct.
  }

  const problems = [
    ...variantProblems,
    // Required, not optional. It is the only text this SKU contributes, and a
    // listing of a hundred variations all called "A1", "A2"… is unusable to a
    // buyer even though TikTok would accept it.
    ...(variant.trim() ? [] : [{ field: 'variant_name', message: 'Variant name is required.' }]),
    ...validatePrice(price),
    ...validateStock(Number.parseInt(stock, 10)),
    ...validateWeight(DEFAULT_WEIGHT_KG),
    ...(photo ? [] : [{ field: 'photo', message: 'A photo is required.' }]),
  ]

  async function save() {
    if (problems.length > 0) {
      setError(problems[0]!.message)
      return
    }
    setBusy('saving')
    setError('')
    try {
      const draft: Draft = {
        draft_id: crypto.randomUUID(),
        listing_id: listing.listing_id,
        // Groups this SKU with the rest of the same factory run, so the queue
        // pushes them one at a time against one listing.
        stream_id: listing.listing_id,
        // Only set when a listing has filled up and its work moves to a new one.
        continues_from: null,
        shop_id: shop.shop_id,
        identifier,
        // The listing's product title, carried for the record. TikTok already
        // holds it on the product and it is not resent per variation.
        title: productTitle,
        variant_name: variant.trim(),
        price,
        stock: Number.parseInt(stock, 10),
        weight_kg: DEFAULT_WEIGHT_KG,
        dimensions: { ...DEFAULT_DIMENSIONS },
        include_dims_in_title: false,
        image_preview: photoUrl,
        tiktok_image_uri: null,
        tiktok_attribute_image_uri: null,
        status: 'queued',
        error: null,
        // Generated here, before any network call, so a retry after a timeout
        // reuses the same key and TikTok returns the original product.
        idempotency_key: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      }
      await enqueue(draft, photo)
      await onSaved()

      // Clear everything that varies per product. Weight and dimensions are
      // constants now, so there is nothing to preserve between SKUs.
      setPhoto(null)
      setPhotoUrl(null)
      setPhotoBase64(null)
      setVariant('')
      setPrice('')
      setStock('')
    } catch (e: unknown) {
      setError(`Could not save: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="bg-raised border border-white/8 rounded-xl p-4 space-y-4">
      <div className="space-y-0.5">
        <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
          New SKU — <span className="text-identifier font-mono">{identifier}</span>
        </p>
        {/* The product title, shown so it is obvious where it comes from and
            that it is not this form's job to set it. */}
        <p className="text-xs text-gray-600 truncate">
          Adding to <span className="text-gray-400">{productTitle}</span>
        </p>
      </div>

      <div className="flex gap-3">
        <CameraCapture preview={photoUrl} busy={busy === 'uploading'} onCapture={acceptPhoto} />
        {/* The two actions stretch to match the photo box beside them. Left at
            their natural height they leave a band of dead space under them,
            which reads as something missing. */}
        <div className="flex flex-col gap-2 flex-1 min-w-0 [&>*]:flex-1">
          <VoiceCapture onFields={applyVoice} />
          <button
            onClick={fillFromPhoto}
            disabled={!photoBase64 || busy !== ''}
            className="text-xs px-3 py-2 rounded-lg bg-purple-600/80 hover:bg-purple-500 disabled:opacity-40 text-white transition-colors"
          >
            {busy === 'naming' ? 'Reading image…' : 'AI suggest variant name from image'}
          </button>
        </div>
      </div>

      {/* One text field, because one is all a variation has. The product name
          is the listing's and is shown above, not typed again here. */}
      <Field label="Variant name">
        <input
          value={variant}
          onChange={(e) => setVariant(e.target.value)}
          placeholder="e.g. Blue Reactive Glaze Mug"
          className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent"
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Price (SGD)">
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="18.90"
            className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent"
          />
        </Field>
        <Field label="Stock">
          <input
            inputMode="numeric"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="50"
            className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent"
          />
        </Field>
      </div>

      <div className="bg-sunken rounded-lg px-3 py-2">
        <p className="text-xs text-gray-500 mb-0.5">
          Buyer sees{variant.trim() ? ` — ${valueName.length}/${VALUE_NAME_MAX} max` : ''}
        </p>
        {/* Before anything is typed this would read as the bare identifier,
            which misrepresents the preview the operator is trusting — so it
            says what is missing instead. */}
        {variant.trim() ? (
          <p className="text-sm font-mono text-white break-words no-inflate">{valueName}</p>
        ) : (
          <p className="text-sm font-mono text-gray-600">
            {identifier} <span className="not-italic">· name it above</span>
          </p>
        )}
        {/* TikTok's own 50-character ceiling, shown as it is approached rather
            than discovered on rejection. */}
        {variantProblems.map((p) => (
          <p key={p.message} className="text-xs text-amber-400 mt-1">
            {p.message}
          </p>
        ))}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={save}
        disabled={busy !== '' || problems.length > 0}
        className="w-full text-sm px-4 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded-lg transition-colors"
      >
        {busy === 'saving' ? 'Saving…' : `Save ${identifier}`}
      </button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">{label}</label>
      {children}
    </div>
  )
}

