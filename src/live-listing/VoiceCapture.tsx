import { useRef, useState } from 'react'
import { api } from '../lib/api'
import { describeMediaError } from '../capture/camera'

/**
 * Voice capture.
 *
 * Built for someone holding a product in one hand: press, describe it, release.
 * Speech may be English, Mandarin, or both in one sentence — the backend
 * translates, because TikTok rejects Chinese characters in product names.
 *
 * A denied microphone degrades to typing rather than blocking the screen. That
 * matters: the fields are all still there, so a refused permission costs
 * convenience, not the job.
 */
export default function VoiceCapture({
  onFields,
}: {
  onFields: (fields: {
    name?: string
    variant?: string
    price?: string
    stock?: number
    weightKg?: string
    dimensions?: { length: string; width: string; height: string }
  }) => void
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'thinking'>('idle')
  const [error, setError] = useState('')
  const [heard, setHeard] = useState('')
  // A partial success, not a failure: the numbers came through but a text
  // field could not be rendered in English. Kept separate from `error` so it
  // reads as "type this bit" rather than "that did not work".
  const [notice, setNotice] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function start() {
    setError('')
    setHeard('')
    setNotice('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Let the browser pick the container. Chrome gives webm, iOS Safari mp4,
      // and Gemini accepts both — pinning one would break a platform.
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType })
        if (audio.size === 0) {
          setState('idle')
          setError('Nothing was recorded.')
          return
        }
        setState('thinking')
        try {
          const result = await api.fieldsFromVoice(audio)
          if (result.unintelligible) {
            setError('Could not make that out. Try again, or type it in.')
          } else {
            setHeard(result.transcript_english)
            if (result.dropped?.length) {
              // Say which field, because "type the name" is actionable and
              // "something went wrong" is not.
              const what = result.dropped.includes('product_name')
                ? result.dropped.length > 1
                  ? 'the name and variant'
                  : 'the name'
                : 'the variant'
              setNotice(
                `Got the numbers. Couldn't put ${what} into English — type it in, or say it in English.`,
              )
            }
            onFields({
              ...(result.title ? { name: result.title } : {}),
              ...(result.variant_name ? { variant: result.variant_name } : {}),
              ...(result.price ? { price: result.price } : {}),
              ...(result.stock !== undefined ? { stock: result.stock } : {}),
              ...(result.weight_kg ? { weightKg: result.weight_kg } : {}),
              ...(result.dimensions ? { dimensions: result.dimensions } : {}),
            })
          }
        } catch (e: unknown) {
          setError(`Could not process the recording: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          setState('idle')
        }
      }
      recorder.start()
      recorderRef.current = recorder
      setState('recording')
    } catch (e: unknown) {
      setError(describeMediaError(e, 'microphone'))
      setState('idle')
    }
  }

  function stop() {
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  return (
    // A flex column with the button stretching, so that when the parent asks
    // this component to fill a column the BUTTON fills it — not an invisible
    // wrapper with a normal-sized button sitting at the top of it.
    <div className="flex flex-col gap-1 h-full">
      <button
        onClick={state === 'recording' ? stop : start}
        disabled={state === 'thinking'}
        aria-label={state === 'recording' ? 'Stop recording' : 'Record details'}
        className={`w-full flex-1 flex flex-col items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors ${
          state === 'recording'
            ? 'bg-red-600 hover:bg-red-500 text-white'
            : 'bg-white/10 hover:bg-white/15 text-white disabled:opacity-40'
        }`}
      >
        {/* Drawn rather than an emoji: an emoji renders differently on every
            platform and at 12px it is illegible on some of them. */}
        {state === 'recording' ? <StopIcon /> : <MicIcon />}
        <span>
          {state === 'recording'
            ? 'Stop recording'
            : state === 'thinking'
              ? // Not "Listening…" — by this point the recording has stopped
                // and the audio is being read. Saying it is still listening
                // invites someone to keep talking into a closed microphone.
                'Reading…'
              : 'Record Details'}
        </span>
      </button>

      {/* Echoed back so a mishearing is visible rather than silently wrong.
          Shown even when a field was dropped — seeing that Mandarin was
          understood correctly is what makes the notice below make sense. */}
      {heard && <p className="text-xs text-gray-500 italic">Heard: {heard}</p>}
      {notice && <p className="text-xs text-sky-300">{notice}</p>}
      {error && <p className="text-xs text-amber-400">{error}</p>}
    </div>
  )
}

/** A microphone. 14px, inherits the button's colour. */
function MicIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      // Decorative: the button already carries an aria-label.
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 19v3" />
    </svg>
  )
}

/** A filled square, the universal stop. */
function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}
