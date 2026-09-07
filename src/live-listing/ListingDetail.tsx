import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ListingState } from '../lib/api'
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
  MAX_SKUS_PER_PRODUCT,
} from '../lib/tiktok-rules'
import { toBase64 } from '../lib/bytes'
import { allDrafts, enqueue, removeDraft } from '../offline/queue'
import type { QueuedDraft } from '../offline/queue'
import type { Draft, Listing, Shop } from '../types'
import PhotoBlock, { ActionButton } from './PhotoBlock'
import VoiceCapture from './VoiceCapture'
import DraftQueue from './DraftQueue'
import BarSpacer from '../ui/BarSpacer'
import BulkAdd from './BulkAdd'
import Icon from '../ui/Icon'
import { useDismiss } from '../ui/useDismiss'

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
  const [editingPrefix, setEditingPrefix] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  /**
   * What the queue learned from its last look at TikTok.
   *
   * Lifted here so the listing bar can show the review state and the real
   * variation count — the two facts that used to be a banner inside the queue
   * and a number nobody could see until they scrolled to it.
   */
  const [live, setLive] = useState<ListingState | null>(null)
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

  const productStatus = live?.product_status ?? null
  const onTikTok = live?.variations_on_tiktok ?? null

  return (
    <div className="space-y-2.5">
      {/*
        The listing, in one 44 px row: back, title, count, review state.

        It replaces a 56 px header (id above name) plus the queue's separate
        review banner, which said the same thing 400 px further down. The
        pill IS the review state — "Live" only when TikTok has approved the
        product, "Reviewing" while it has not.
      */}
      <div className="flex items-center gap-2 h-11">
        <button
          onClick={onBack}
          className="min-h-11 min-w-11 -ml-2 inline-flex items-center justify-center text-muted"
          aria-label="Back to listings"
        >
          <Icon name="chevron-right" size={20} className="rotate-180" />
        </button>
        <span className="text-sm font-semibold text-fg truncate min-w-0 flex-1">
          {listing.product_name ?? shop.brand}
        </span>
        <span className="text-xs text-muted shrink-0 whitespace-nowrap">
          {onTikTok === null ? `${drafts.length}` : `${onTikTok}`}/{MAX_SKUS_PER_PRODUCT}
        </span>
        <ListingPill status={productStatus} />
      </div>

      {/* The daily cap is surfaced before it bites. New shops are limited to
          100 uploads a day, which a 200-SKU stream would hit at item 101.
          Only warned on a number we actually know: without server-side push
          tracking the figure is null, and inventing a confident one would be
          worse than showing none — it would be trusted. */}
      {allowance && allowance.remaining !== null && allowance.remaining <= 25 && (
        <p
          className={`text-xs rounded-lg px-3 py-2 border ${
            allowance.remaining === 0
              ? 'bg-bad-tint border-bad-line text-bad'
              : 'bg-warn-tint border-warn-line text-warn'
          }`}
        >
          {allowance.remaining === 0
            ? `${shop.brand} has used its ${allowance.cap} product uploads for today. Further pushes will be rejected until midnight Singapore time.`
            : `${allowance.remaining} of ${shop.brand}'s ${allowance.cap} daily product uploads left.`}
        </p>
      )}

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
        <div className="min-w-0">
          <SkuForm
            shop={shop}
            listing={listing}
            identifier={formatIdentifier(next.prefix, next.seq)}
            prefix={next.prefix}
            onEditPrefix={() => setEditingPrefix(true)}
            onBulkAdd={() => setBulkOpen(true)}
            onSaved={refreshDrafts}
          />
        </div>

        <div className="listing-queue min-w-0">
          <DraftQueue
            drafts={drafts}
            listingId={listing.listing_id}
            onChanged={refreshDrafts}
            onLive={setLive}
            onDelete={async (id) => {
              await removeDraft(id)
              await refreshDrafts()
            }}
          />
        </div>
      </div>

      {editingPrefix && (
        <PrefixSheet
          prefix={prefix}
          nextIdentifier={formatIdentifier(next.prefix, next.seq)}
          onPrefix={setPrefix}
          onClose={() => setEditingPrefix(false)}
        />
      )}

      {bulkOpen && (
        <Sheet title="Bulk add" onClose={() => setBulkOpen(false)}>
          <BulkAdd
            shop={shop}
            listing={listing}
            startIdentifier={formatIdentifier(next.prefix, next.seq)}
            onSaved={async () => {
              await refreshDrafts()
              setBulkOpen(false)
            }}
          />
        </Sheet>
      )}

      {/* Clears the fixed List bar this screen adds. */}
      <BarSpacer />
    </div>
  )
}

/**
 * TikTok's review state for the whole product, as three words.
 *
 * This was a three-line banner inside the queue. It says one thing — is this
 * buyable — so it is one pill, in the listing bar, where the count it belongs
 * with already is.
 */
function ListingPill({ status }: { status: string | null }) {
  if (status === null) {
    return <span className="text-xs text-ghost shrink-0">—</span>
  }
  const known: Record<string, { label: string; cls: string }> = {
    ACTIVATE: { label: 'Live', cls: 'bg-ok-tint text-ok' },
    PENDING: { label: 'Reviewing', cls: 'bg-warn-tint text-warn' },
    FAILED: { label: 'Rejected', cls: 'bg-bad-tint text-bad' },
    FREEZE: { label: 'Frozen', cls: 'bg-bad-tint text-bad' },
    DEACTIVATED: { label: 'Off', cls: 'bg-chip text-muted' },
    DRAFT: { label: 'Draft', cls: 'bg-chip text-muted' },
  }
  // An unrecognised status is shown verbatim rather than mapped to "unknown":
  // TikTok adding a state must not make the app lie about it.
  const shown = known[status] ?? { label: status, cls: 'bg-chip text-muted' }
  return (
    <span
      className={`shrink-0 inline-flex items-center h-6 px-2 rounded-md text-xs font-semibold ${shown.cls}`}
    >
      {shown.label}
    </span>
  )
}

/**
 * The prefix editor, on demand.
 *
 * A 130 px card carried this permanently, for a value that is set once at the
 * start of a factory run and then never touched. Now the identifier in the
 * card header opens it.
 */
function PrefixSheet({
  prefix,
  nextIdentifier: next,
  onPrefix,
  onClose,
}: {
  prefix: string
  nextIdentifier: string
  onPrefix: (value: string) => void
  onClose: () => void
}) {
  return (
    <Sheet title="SKU prefix" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="prefix" className="text-xs text-muted">
              Prefix
            </label>
            <input
              id="prefix"
              value={prefix}
              onChange={(e) => onPrefix(cleanPrefix(e.target.value))}
              // maxLength as well as the slice in cleanPrefix: the attribute
              // stops the keystroke, which means no cursor jump, and the slice
              // catches a paste or an autofill that bypasses it.
              maxLength={PREFIX_MAX}
              // The value is upper-cased on every keystroke, so the on-screen
              // keyboard should offer capitals to match.
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="w-28 bg-sunken border border-line rounded-lg px-3 h-11 text-sm text-fg font-mono uppercase tracking-widest outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Next SKU</span>
            {/* Derived, not typed. The old app let you set the next number by
                hand, which is one more thing to get wrong mid-stream. */}
            <p className="font-mono text-xl text-identifier leading-none h-11 flex items-center">
              {next}
            </p>
          </div>
        </div>
        <p className="text-xs text-faint">
          Up to {PREFIX_MAX} letters, capitals. The number continues from what is already
          listed and queued, so it cannot repeat.
        </p>
        <button
          onClick={onClose}
          className="w-full min-h-11 rounded-xl bg-accent hover:bg-accent-hover text-sm font-semibold text-white"
        >
          Done
        </button>
      </div>
    </Sheet>
  )
}

/**
 * A bottom sheet.
 *
 * Bottom rather than centred: it opens next to the thumb that asked for it,
 * and the scrim gives a second way out — tapping away — for someone holding a
 * product in the other hand.
 */
function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  useDismiss(onClose)
  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center">
      <button className="absolute inset-0 bg-scrim" onClick={onClose} aria-label="Close" />
      <div className="relative w-full sm:max-w-md max-h-[85dvh] overflow-y-auto bg-surface border-t sm:border border-line rounded-t-2xl sm:rounded-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2 mb-2.5">
          <h2 className="text-sm font-semibold text-fg flex-1">{title}</h2>
          <button
            onClick={onClose}
            className="min-h-11 min-w-11 -mr-1 inline-flex items-center justify-center text-muted"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function SkuForm({
  shop,
  listing,
  identifier,
  prefix,
  onEditPrefix,
  onBulkAdd,
  onSaved,
}: {
  shop: Shop
  listing: Listing
  identifier: string
  prefix: string
  /** Opens the prefix editor. The identifier in the header is the trigger. */
  onEditPrefix: () => void
  /** Opens bulk add. A link in the header, not a card of its own. */
  onBulkAdd: () => void
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
  /** Voice's feedback, rendered under the button grid rather than inside it. */
  const [voiceStatus, setVoiceStatus] = useState({ heard: '', notice: '', error: '' })
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
    <div className="bg-raised border border-line2 rounded-xl p-3 space-y-2.5">
      {/*
        The identifier IS the header, at 22px in amber.

        It used to have a card of its own — a 130 px block holding a prefix
        input, the next number and two lines of help — above a card that
        repeated the same identifier in 12px grey. One number, stated once,
        where the eye already is. Tapping it opens the prefix editor.
      */}
      <div className="flex items-baseline gap-2">
        <button
          onClick={onEditPrefix}
          className="font-mono text-[22px] font-semibold text-identifier tracking-wide leading-none"
          aria-label={`Next SKU ${identifier}. Change the prefix.`}
        >
          {identifier}
        </button>
        <span className="text-xs text-faint min-w-0 truncate">next SKU · prefix {prefix}</span>
        <span className="flex-1" />
        <button onClick={onBulkAdd} className="text-xs text-muted underline underline-offset-3 shrink-0">
          Bulk add
        </button>
      </div>

      <PhotoBlock
        preview={photoUrl}
        busy={busy === 'uploading'}
        onCapture={acceptPhoto}
        voice={<VoiceCapture onFields={applyVoice} onStatus={setVoiceStatus} />}
        aiName={
          <ActionButton
            onClick={() => void fillFromPhoto()}
            disabled={!photoBase64 || busy !== ''}
            tone="plain"
            icon="sparkle"
          >
            {busy === 'naming' ? 'Reading…' : 'AI name'}
          </ActionButton>
        }
      />

      {/* Voice's own feedback, under the grid where a sentence fits. */}
      {voiceStatus.heard && <p className="text-xs text-faint italic">Heard: {voiceStatus.heard}</p>}
      {voiceStatus.notice && <p className="text-xs text-info">{voiceStatus.notice}</p>}
      {voiceStatus.error && <p className="text-xs text-warn">{voiceStatus.error}</p>}

      {/* One text field, because one is all a variation has. The product name
          is the listing's, shown in the bar above, not typed again here.

          The buyer-facing preview sits directly under the field instead of in
          a box of its own: it is what this field produces, so putting 12px of
          padding and a background between them made it read as a separate
          fact. */}
      <div className="space-y-1">
        <input
          value={variant}
          onChange={(e) => setVariant(e.target.value)}
          placeholder="Variant name — say it, or type it"
          aria-label="Variant name"
          className="w-full bg-sunken border border-line rounded-lg px-3 h-11 text-sm text-fg outline-none focus:border-accent"
        />
        {variant.trim() ? (
          <p className="text-xs font-mono text-muted break-words no-inflate pl-0.5">
            {valueName}
            <span className="text-ghost"> · {valueName.length}/{VALUE_NAME_MAX}</span>
          </p>
        ) : (
          <p className="text-xs font-mono text-ghost pl-0.5">{identifier} · name it above</p>
        )}
        {/* TikTok's own 50-character ceiling, shown as it is approached rather
            than discovered on rejection. */}
        {variantProblems.map((p) => (
          <p key={p.message} className="text-xs text-warn pl-0.5">
            {p.message}
          </p>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-faint pointer-events-none">
            $
          </span>
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Price"
            aria-label="Price in Singapore dollars"
            className="w-full bg-sunken border border-line rounded-lg pl-7 pr-3 h-11 text-sm text-fg outline-none focus:border-accent"
          />
        </div>
        <input
          inputMode="numeric"
          value={stock}
          onChange={(e) => setStock(e.target.value)}
          placeholder="Stock"
          aria-label="Stock"
          className="w-full bg-sunken border border-line rounded-lg px-3 h-11 text-sm text-fg outline-none focus:border-accent"
        />
      </div>

      {error && <p className="text-xs text-bad">{error}</p>}

      {/* On a phone this is a duplicate of the fixed bar at the bottom of the
          screen, and hidden; on an iPad, where there is no bottom bar, it is
          the only one. Same handler either way. */}
      <button
        onClick={save}
        disabled={busy !== '' || problems.length > 0}
        className="hidden md:flex w-full min-h-11 items-center justify-center rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-40 text-sm font-semibold text-white transition-colors"
      >
        {busy === 'saving' ? 'Listing…' : `List ${identifier}`}
      </button>

      {/*
        The phone's List button: fixed above the tab bar, always in reach.

        Not in the card, because the card scrolls — and the whole point of the
        redesign is that the queue is on screen while a SKU is being added,
        which means the card's bottom edge is often off it. `bottom-14` clears
        the tab bar; the safe-area inset clears the home indicator.
      */}
      <div
        className="md:hidden fixed left-0 right-0 z-10 px-3 py-1.5 bg-surface border-t border-line2"
        style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-5xl mx-auto">
          <button
            onClick={save}
            disabled={busy !== '' || problems.length > 0}
            className="w-full min-h-11 flex items-center justify-center rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-[15px] font-semibold text-white transition-colors"
          >
            {busy === 'saving' ? 'Listing…' : `List ${identifier}`}
          </button>
        </div>
      </div>
    </div>
  )
}


