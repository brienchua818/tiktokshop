import type { ReactNode } from 'react'
import Icon from '../ui/Icon'
import { useCamera } from './useCamera'

/**
 * The photo square and the four actions beside it.
 *
 * The layout is the point: a 112 px preview on the left, and Camera, Voice,
 * Photos and AI name as four 52 px buttons filling the right half of the
 * screen — where a right thumb already rests. Before this the two AI actions
 * were stacked in a narrow column beside the photo and the whole block was
 * 420 px tall; it is now 292 px, which is what put the SKU queue back on
 * screen while adding a SKU.
 *
 * `voice` and `aiName` are passed in rather than built here because they are
 * the caller's business — one records audio and fills three fields, the other
 * needs the encoded photo.
 */
export default function PhotoBlock({
  preview,
  busy,
  onCapture,
  voice,
  aiName,
}: {
  preview: string | null
  busy: boolean
  onCapture: (blob: Blob) => void | Promise<void>
  voice: ReactNode
  aiName: ReactNode
}) {
  const camera = useCamera(onCapture)

  return (
    <div className="space-y-2">
      <div className="flex gap-2.5">
        {/* The square: live view while shooting, the photo once taken, an
            empty frame before that. Tapping it opens the camera too, so the
            obvious target works as well as the labelled button. */}
        {camera.live ? (
          <div className="w-28 shrink-0 space-y-1">
            <div className="relative">
              <video
                ref={camera.videoRef}
                playsInline
                muted
                autoPlay
                className="w-28 h-28 object-cover rounded-xl bg-black"
              />
              {/* Says why the square is black, rather than leaving it looking
                  broken for the second or so the camera takes to wake up. */}
              {!camera.ready && (
                <span className="absolute inset-0 flex items-center justify-center text-xs text-muted">
                  Starting…
                </span>
              )}
            </div>
          </div>
        ) : preview ? (
          <button
            onClick={camera.start}
            className="w-28 h-28 shrink-0 relative rounded-xl overflow-hidden"
            aria-label="Retake photo"
          >
            <img src={preview} alt="Product" className="w-28 h-28 object-cover" />
            {busy && (
              <span className="absolute inset-0 flex items-center justify-center bg-scrim text-xs text-white">
                Uploading…
              </span>
            )}
          </button>
        ) : (
          <button
            onClick={camera.start}
            className="w-28 h-28 shrink-0 border border-dashed border-line3 rounded-xl flex items-center justify-center text-ghost hover:border-accent/50 hover:text-muted transition-colors"
            aria-label="Take a photo"
          >
            <Icon name="image" size={28} />
          </button>
        )}

        {/* Four buttons, two by two, filling the width beside the photo. While
            the camera is live the first two become Take and Cancel, in the
            same places — so the shutter is where the camera button was. */}
        <div className="grid grid-cols-2 gap-2 flex-1 min-w-0 [&>*]:min-h-13">
          {camera.live ? (
            <>
              <ActionButton onClick={() => void camera.shoot()} disabled={!camera.ready} tone="primary" icon="camera">
                Take
              </ActionButton>
              <ActionButton onClick={camera.stop} tone="plain" icon="close">
                Cancel
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton onClick={camera.start} tone="primary" icon="camera">
                Camera
              </ActionButton>
              {voice}
            </>
          )}
          <ActionButton
            onClick={() => camera.fileRef.current?.click()}
            tone="plain"
            icon="image"
          >
            Photos
          </ActionButton>
          {aiName}
        </div>
      </div>

      <input
        ref={camera.fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void camera.fromFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {camera.error && <p className="text-xs text-bad">{camera.error}</p>}
    </div>
  )
}

/**
 * One of the four. Exported so Voice and AI name look identical to Camera and
 * Photos — four buttons that differ in colour would read as four kinds of
 * thing, when they are all "give this SKU its details".
 */
export function ActionButton({
  onClick,
  disabled = false,
  tone,
  icon,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  tone: 'primary' | 'voice' | 'plain' | 'stop'
  icon: 'camera' | 'mic' | 'image' | 'sparkle' | 'close'
  children: ReactNode
}) {
  const tones = {
    primary: 'bg-accent hover:bg-accent-hover text-white border-accent',
    voice: 'bg-voice hover:bg-voice-hover text-white border-voice',
    plain: 'bg-sunken hover:border-accent/40 text-fg2 border-line',
    // Recording. Red because it is the one button here that is mid-action and
    // needs to be found without looking.
    stop: 'bg-bad-solid hover:bg-bad-solid-hover text-white border-bad-solid',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border flex items-center justify-center gap-1.5 text-sm font-medium disabled:opacity-40 transition-colors ${tones[tone]}`}
    >
      <Icon name={icon} size={20} />
      {children}
    </button>
  )
}
