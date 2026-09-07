import { useEffect, useRef, useState } from 'react'
import {
  captureFrame,
  describeMediaError,
  openCamera,
  stopStream,
  toSquareJpeg,
  waitForFrame,
} from '../capture/camera'

/**
 * Photo capture, in-app — the logic, with no opinion about layout.
 *
 * Pulled out of the old CameraCapture component so the redesign could put the
 * preview square on the left and its two actions into the 2×2 button grid on
 * the right. Every fix that made the camera work on an iPhone lives here:
 *   - the stream is attached in an effect keyed on `live`, AFTER React has
 *     committed the <video>, not in requestAnimationFrame (which fired before
 *     the element existed and left the preview black);
 *   - `waitForFrame` decides when the shutter is armed, so "not ready yet" is
 *     a real state rather than a guess;
 *   - the stream is always released, or the phone's camera indicator stays lit
 *     and the battery drains through a three-hour stream.
 *
 * Two routes on purpose. The live camera is the fast path with the product in
 * hand; the file input is the fallback, because some in-app browsers block
 * getUserMedia outright and losing the ability to photograph a product would
 * stop the whole job.
 */
export function useCamera(onCapture: (blob: Blob) => void | Promise<void>) {
  const [live, setLive] = useState(false)
  /** Has the video produced a frame? Until it has, there is nothing to shoot. */
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(
    () => () => {
      stopStream(streamRef.current)
      streamRef.current = null
    },
    [],
  )

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

  return { live, ready, error, videoRef, fileRef, start, stop, shoot, fromFile }
}
