import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { buildTitle, formatIdentifier, nextIdentifier } from '../lib/identifiers'
import {
  validateTitle,
  validatePrice,
  validateStock,
  validateWeight,
  DEFAULT_WEIGHT_KG,
  DEFAULT_DIMENSIONS,
  TITLE_MIN,
} from '../lib/tiktok-rules'
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
  const [prefix, setPrefix] = useState('A')
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

  // The next identifier, considering both what is live and what is queued —
  // ignoring either is how two SKUs end up sharing an identifier.
  const next = useMemo(
    () => nextIdentifier(listedSkus, drafts.map((d) => d.identifier), prefix),
    [listedSkus, drafts, prefix],
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

      <DraftQueue
        drafts={drafts}
        onChanged={refreshDrafts}
        onDelete={async (id) => {
          await removeDraft(id)
          await refreshDrafts()
        }}
      />
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
      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="prefix" className="text-xs text-gray-400">
            Prefix
          </label>
          <input
            id="prefix"
            value={prefix}
            onChange={(e) => onPrefix(e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase())}
            className="w-20 bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono outline-none focus:border-accent"
          />
        </div>
        <div className="flex-1">
          <p className="text-xs text-gray-500 mb-0.5">Next SKU</p>
          {/* Derived, not typed. The old app let you set the next number by
              hand, which is one more thing to get wrong mid-stream. */}
          <p className="text-lg font-mono text-identifier">{next}</p>
        </div>
      </div>
      <p className="text-xs text-gray-600">
        Continues from what is already listed and queued, so it cannot repeat.
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
  const [name, setName] = useState('')
  const [variant, setVariant] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  const [uploaded, setUploaded] = useState<{
    tiktok_image_uri: string
    tiktok_attribute_image_uri: string
    ai_image_url: string
  } | null>(
    null,
  )
  const [busy, setBusy] = useState<'' | 'uploading' | 'titling' | 'saving'>('')
  const [error, setError] = useState('')
  const objectUrl = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    },
    [],
  )

  // No dimensions in the title: they are a fixed shipping declaration, not a
  // measurement of this product, so putting them here would misdescribe it.
  const title = buildTitle({ identifier, productName: name, includeDims: false })
  const titleProblems = name ? validateTitle(title) : []

  async function acceptPhoto(blob: Blob) {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = URL.createObjectURL(blob)
    setPhoto(blob)
    setPhotoUrl(objectUrl.current)
    setUploaded(null)
    setError('')

    // Upload straight away rather than at save time: it needs a connection,
    // and finding that out while the operator is still holding the product is
    // far better than at the end.
    setBusy('uploading')
    try {
      const result = await api.uploadPhoto(shop.shop_id, blob)
      setUploaded(result)
    } catch (e: unknown) {
      // Not fatal. The photo is kept locally and the queue uploads it later.
      setError(
        e instanceof ApiError && e.status === 0
          ? 'Photo saved on this device — it will upload when the connection returns.'
          : `Photo upload failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setBusy('')
    }
  }

  async function fillFromPhoto() {
    if (!uploaded) {
      setError('The photo has not uploaded yet, so it cannot be read.')
      return
    }
    setBusy('titling')
    setError('')
    try {
      const result = await api.titleFromPhoto(uploaded.ai_image_url, name || undefined)
      if (result.title) setName(stripIdentifier(result.title, identifier))
      if (result.variant_name) setVariant(result.variant_name)
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
    if (fields.name) setName(fields.name)
    if (fields.variant) setVariant(fields.variant)
    if (fields.price) setPrice(fields.price)
    if (fields.stock !== undefined) setStock(String(fields.stock))
    // Spoken weight and dimensions are deliberately ignored: both are fixed
    // declarations now, so accepting them here would silently reintroduce a
    // field nobody can see or correct.
  }

  const problems = [
    ...titleProblems,
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
        shop_id: shop.shop_id,
        identifier,
        title,
        variant_name: variant || null,
        price,
        stock: Number.parseInt(stock, 10),
        weight_kg: DEFAULT_WEIGHT_KG,
        dimensions: { ...DEFAULT_DIMENSIONS },
        include_dims_in_title: false,
        image_preview: photoUrl,
        tiktok_image_uri: uploaded?.tiktok_image_uri ?? null,
        tiktok_attribute_image_uri: uploaded?.tiktok_attribute_image_uri ?? null,
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
      setUploaded(null)
      setName('')
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
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
          New SKU — <span className="text-identifier font-mono">{identifier}</span>
        </p>
      </div>

      <div className="flex gap-3">
        <CameraCapture preview={photoUrl} busy={busy === 'uploading'} onCapture={acceptPhoto} />
        <div className="flex flex-col gap-2 flex-1">
          <VoiceCapture onFields={applyVoice} />
          <button
            onClick={fillFromPhoto}
            disabled={!uploaded || busy !== ''}
            className="text-xs px-3 py-2 rounded-lg bg-purple-600/80 hover:bg-purple-500 disabled:opacity-40 text-white transition-colors"
          >
            {busy === 'titling' ? 'Reading photo…' : 'Write title from photo'}
          </button>
        </div>
      </div>

      <Field label="Product name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ceramic Serving Bowl White Glaze"
          className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent"
        />
      </Field>

      <Field label="Variant (optional)">
        <input
          value={variant}
          onChange={(e) => setVariant(e.target.value)}
          placeholder="e.g. White"
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
          Title preview — {title.length}/{TITLE_MIN} minimum
        </p>
        <p className="text-sm font-mono text-white break-words">{title}</p>
        {/* The 25-character floor is TikTok's own rule, so it is shown as it is
            approached rather than discovered on rejection. */}
        {titleProblems.map((p) => (
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

/**
 * The model is asked for a full title, but the identifier is prepended
 * separately — so strip it if the model included one, rather than shipping
 * "A1-A1-Ceramic Bowl".
 */
function stripIdentifier(title: string, identifier: string): string {
  const pattern = new RegExp(`^${identifier}[-\\s]*`, 'i')
  return title.replace(pattern, '').trim()
}
