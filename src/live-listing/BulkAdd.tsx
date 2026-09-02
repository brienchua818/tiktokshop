import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { toSquareJpeg } from '../capture/camera'
import { buildTitle, formatIdentifier, parseIdentifier } from '../lib/identifiers'
import {
  validateTitle,
  validatePrice,
  validateStock,
  DEFAULT_WEIGHT_KG,
  DEFAULT_DIMENSIONS,
} from '../lib/tiktok-rules'
import { enqueue } from '../offline/queue'
import type { Draft, Listing, Shop } from '../types'

/**
 * Bulk add: one set of details, many photos.
 *
 * Carried over from the app being replaced. It exists because a factory run is
 * often the same product in a dozen finishes — same name, same price, same
 * stock, different photo. Entering that twelve times is the kind of friction
 * that makes people stop using a tool mid-livestream.
 *
 * Each photo becomes its own SKU with its own sequential identifier, so a
 * gallery of twelve produces A5 through A16 in one action.
 */
export default function BulkAdd({
  shop,
  listing,
  startIdentifier,
  onSaved,
}: {
  shop: Shop
  listing: Listing
  /** The next free identifier, e.g. "A5". Subsequent SKUs continue from it. */
  startIdentifier: string
  onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [photos, setPhotos] = useState<{ blob: Blob; url: string }[]>([])
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const urls = useRef<string[]>([])

  // Object URLs are only freed on unmount, not per render — revoking one still
  // shown in the grid would blank the thumbnail.
  useEffect(
    () => () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u))
    },
    [],
  )

  const parsed = parseIdentifier(startIdentifier)
  const prefix = parsed?.prefix ?? 'A'
  const firstSeq = parsed?.seq ?? 1

  // Preview against the first identifier: if the title is too short it will be
  // too short for every photo, so it is worth seeing before adding twelve.
  const sampleTitle = buildTitle({
    identifier: formatIdentifier(prefix, firstSeq),
    productName: name,
    includeDims: false,
  })
  const titleProblems = name ? validateTitle(sampleTitle) : []

  async function addFiles(files: FileList | null) {
    if (!files?.length) return
    setError('')
    const accepted: { blob: Blob; url: string }[] = []
    for (const file of Array.from(files)) {
      try {
        // Same square-crop path as a live capture, so a gallery photo and a
        // camera shot reach TikTok identically.
        const blob = await toSquareJpeg(file)
        const url = URL.createObjectURL(blob)
        urls.current.push(url)
        accepted.push({ blob, url })
      } catch {
        setError(`Could not read ${file.name}. Skipped it.`)
      }
    }
    setPhotos((prev) => [...prev, ...accepted])
  }

  function removePhoto(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index))
  }

  const problems = [
    ...titleProblems,
    ...validatePrice(price),
    ...validateStock(Number.parseInt(stock, 10)),
    ...(photos.length === 0 ? [{ field: 'photos', message: 'Add at least one photo.' }] : []),
  ]

  async function saveAll() {
    if (problems.length > 0) {
      setError(problems[0]!.message)
      return
    }
    setBusy(true)
    setError('')

    let saved = 0
    for (const [index, photo] of photos.entries()) {
      const identifier = formatIdentifier(prefix, firstSeq + index)
      setProgress(`Saving ${identifier} — ${index + 1} of ${photos.length}`)

      // Upload each photo as we go rather than all at once: on a factory
      // connection a dozen parallel uploads is how you get a dozen timeouts.
      let imageUri: string | null = null
      try {
        const uploaded = await api.uploadPhoto(shop.shop_id, photo.blob)
        imageUri = uploaded.tiktok_image_uri
      } catch (e: unknown) {
        // Not fatal — the photo is kept locally and the queue retries it.
        if (!(e instanceof ApiError)) throw e
      }

      const draft: Draft = {
        draft_id: crypto.randomUUID(),
        listing_id: listing.listing_id,
        shop_id: shop.shop_id,
        identifier,
        title: buildTitle({ identifier, productName: name, includeDims: false }),
        variant_name: null,
        price,
        stock: Number.parseInt(stock, 10),
        weight_kg: DEFAULT_WEIGHT_KG,
        dimensions: { ...DEFAULT_DIMENSIONS },
        include_dims_in_title: false,
        image_preview: photo.url,
        tiktok_image_uri: imageUri,
        status: 'queued',
        error: null,
        idempotency_key: crypto.randomUUID(),
        created_at: new Date(Date.now() + index).toISOString(),
      }
      await enqueue(draft, photo.blob)
      saved += 1
    }

    setProgress('')
    setBusy(false)
    await onSaved()

    if (saved === photos.length) {
      setPhotos([])
      setName('')
      setPrice('')
      setStock('')
      setOpen(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full text-xs px-4 py-2.5 border border-dashed border-white/20 rounded-xl text-gray-400 hover:border-accent/50 hover:text-gray-200 transition-colors"
      >
        Bulk add — same details, many photos
      </button>
    )
  }

  return (
    <div className="bg-raised border border-white/8 rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-400 font-medium uppercase tracking-wide flex-1">
          Bulk add — {photos.length === 0 ? 'pick photos' : `${photos.length} photos`}
        </p>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-white">
          Close
        </button>
      </div>

      <button
        onClick={() => fileRef.current?.click()}
        className="w-full text-xs px-3 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg transition-colors"
      >
        Choose photos
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {photos.map((photo, index) => (
            <div key={photo.url} className="relative">
              <img src={photo.url} alt="" className="w-full aspect-square object-cover rounded-lg" />
              {/* The identifier each photo will get, so the mapping is visible
                  before committing a dozen SKUs. */}
              <span className="absolute bottom-0 left-0 right-0 text-[10px] text-center bg-black/70 text-identifier font-mono rounded-b-lg">
                {formatIdentifier(prefix, firstSeq + index)}
              </span>
              <button
                onClick={() => removePhoto(index)}
                disabled={busy}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-black/80 text-gray-300 hover:text-red-400 text-xs leading-none"
                aria-label="Remove photo"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">Product name — used for every photo</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ceramic Serving Bowl White Glaze"
          className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Price (SGD)</label>
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="18.90"
            className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Stock, each</label>
          <input
            inputMode="numeric"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="50"
            className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent"
          />
        </div>
      </div>

      <div className="bg-sunken rounded-lg px-3 py-2">
        <p className="text-xs text-gray-500 mb-0.5">
          First title — {sampleTitle.length}/25 minimum
        </p>
        <p className="text-sm font-mono text-white break-words">{sampleTitle}</p>
        {titleProblems.map((p) => (
          <p key={p.message} className="text-xs text-amber-400 mt-1">
            {p.message}
          </p>
        ))}
      </div>

      {progress && <p className="text-xs text-blue-400">{progress}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={saveAll}
        disabled={busy || problems.length > 0}
        className="w-full text-sm px-4 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded-lg transition-colors"
      >
        {busy
          ? 'Saving…'
          : photos.length > 0
            ? `Save ${photos.length} SKUs — ${formatIdentifier(prefix, firstSeq)} to ${formatIdentifier(prefix, firstSeq + photos.length - 1)}`
            : 'Save'}
      </button>
    </div>
  )
}
