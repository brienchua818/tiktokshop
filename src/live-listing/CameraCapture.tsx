import { useEffect, useRef, useState } from 'react'
import { captureFrame, openCamera, stopStream, toSquareJpeg, describeMediaError } from '../capture/camera'

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

  async function start() {
    setError('')
    try {
      const stream = await openCamera()
      streamRef.current = stream
      setLive(true)
      // The element only exists after the state flip, so attach on the next tick.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play()
        }
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : describeMediaError(e, 'camera'))
      setLive(false)
    }
  }

  function stop() {
    stopStream(streamRef.current)
    streamRef.current = null
    setLive(false)
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
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-32 h-32 object-cover rounded-lg bg-black"
          />
          <div className="flex gap-1">
            <button
              onClick={shoot}
              className="flex-1 text-xs py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg"
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
