import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { toBase64 } from '../lib/bytes'
import { describeMediaError } from '../capture/camera'
import { ActionButton } from './PhotoBlock'

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
  onStatus,
}: {
  /**
   * What was heard, and anything that needs typing by hand.
   *
   * Reported upward rather than rendered here, because the button is now one
   * cell of a 2×2 grid: feedback drawn inside the cell would either stretch
   * the whole grid or be clipped. The parent shows it under the grid, where
   * there is room for a sentence.
   */
  onStatus?: (status: { heard: string; notice: string; error: string }) => void
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

  // Kept as one effect rather than calling onStatus from each setter: three
  // setters firing in one handler would otherwise send three partial updates.
  useEffect(() => {
    onStatus?.({ heard, notice, error })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heard, notice, error])

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
          const result = await api.fieldsFromVoice(await toBase64(audio), recorder.mimeType)
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

  const recording = state === 'recording'
  return (
    <ActionButton
      onClick={recording ? stop : start}
      disabled={state === 'thinking'}
      tone={recording ? 'stop' : 'voice'}
      icon="mic"
    >
      {recording ? 'Stop' : state === 'thinking' ? 'Reading…' : 'Voice'}
    </ActionButton>
  )
}

