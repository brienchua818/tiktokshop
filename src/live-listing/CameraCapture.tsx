import { useEffect, useRef, useState } from 'react'
import {
  captureFrame,
  openCamera,
  stopStream,
  toSquareJpeg,
  describeMediaError,
  waitForFrame,
} from '../capture/camera'

/**
 * Photo capture, in-app.
 *
 * Two routes on purpose. The live camera is the fast path when the product is
 * in hand. The file input is the fallback — some in-app browsers block
 * getUserMedia outright, and losing the ability to photograph a product would
 * stop the whole job, so there is always a way through.
 */
export default function CameraCapture({
  preview,
  busy,
  onCapture,
}: {
  preview: string | null
  busy: boolean
  onCapture: (blob: Blob) => void | Promise<void>
}) {
  const [live, setLive] = useState(false)
  /** Has the video produced a frame? Until it has, there is nothing to shoot. */
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Always release the camera. Leaving it running keeps the phone's indicator
  // lit and drains the battery through a three-hour stream.
  useEffect(
    () => () => {
      stopStream(streamRef.current)
      streamRef.current = null
    },
    [],
  )

  /**
   * Attach the stream once the <video> is actually in the DOM.
   *
   * This used to run inside requestAnimationFrame, which fires on the next
   * paint — not necessarily after React has committed the element. So the
   * stream was sometimes attached to nothing, the preview stayed black, and
   * the shutter reported "the camera is not ready yet". An effect keyed on
   * `live` runs after the commit, which is the guarantee that was missing.
   */
  useEffect(() => {
    const video = videoRef.current
    const stream = streamRef.current
    if (!live || !video || !stream) return

    let cancelled = false
    video.srcObject = stream
    // Muted and playsInline, so iOS allows this without a fresh user gesture.
    void video.play().catch(() => {
      /* play() rejects if the element is torn down first; waitForFrame decides. */
    })

    waitForFrame(video)
      .then(() => !cancelled && setReady(true))
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })

    return () => {
      cancelled = true
    }
  }, [live])

  async function start() {
    setError('')
    setReady(false)
    try {
      streamRef.current = await openCamera()
      setLive(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : describeMediaError(e, 'camera'))
      setLive(false)
    }
  }

  function stop() {
    stopStream(streamRef.current)
    streamRef.current = null
    setLive(false)
    setReady(false)
  }

  async function shoot() {
    if (!videoRef.current) return
    try {
      const blob = await captureFrame(videoRef.current)
      stop()
      await onCapture(blob)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function fromFile(file: File | undefined) {
    if (!file) return
    setError('')
    try {
      // Re-encoded through the same square-crop path, so a gallery photo and a
      // live capture reach TikTok identically.
      await onCapture(await toSquareJpeg(file))
    } catch (e: unknown) {
      setError(`Could not read that image: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="w-32 shrink-0 space-y-1">
      {live ? (
        <div className="space-y-1">
          <div className="relative">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="w-32 h-32 object-cover rounded-lg bg-black"
            />
            {/* Says why the square is black, rather than leaving it looking
                broken for the second or so the camera takes to wake up. */}
            {!ready && (
              <span className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
                Starting…
              </span>
            )}
          </div>
          <div className="flex gap-1">
            <button
              onClick={shoot}
              disabled={!ready}
              className="flex-1 text-xs py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded-lg"
            >
              Take
            </button>
            <button onClick={stop} className="text-xs px-2 py-1.5 text-gray-400 hover:text-white">
              ✕
            </button>
          </div>
        </div>
      ) : preview ? (
        <button onClick={start} className="block relative">
          <img src={preview} alt="Product" className="w-32 h-32 object-cover rounded-lg" />
          {busy && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-lg text-xs text-white">
              Uploading…
            </span>
          )}
        </button>
      ) : (
        <button
          onClick={start}
          className="w-32 h-32 border border-dashed border-white/20 rounded-lg flex flex-col items-center justify-center gap-1 text-gray-500 hover:border-accent/50 hover:text-gray-300 transition-colors"
        >
          <span className="text-2xl leading-none">＋</span>
          <span className="text-xs">Photo</span>
        </button>
      )}

      <button
        onClick={() => fileRef.current?.click()}
        className="w-full text-xs text-gray-500 hover:text-gray-300"
      >
        Choose file
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void fromFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
