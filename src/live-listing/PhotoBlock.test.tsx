// @vitest-environment happy-dom
/**
 * "Photos" opens the photo library, not the camera.
 *
 * Brien, 17 Oct, on an iPhone: choosing Photos opened the camera. The input
 * carried `capture="environment"`, which tells the phone to skip the library,
 * and iOS obeys it. The Camera button is the in-app live camera and never used
 * this input, so the attribute bought nothing and broke the other button.
 */
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import PhotoBlock from './PhotoBlock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function render() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  await act(async () => {
    createRoot(el).render(
      <PhotoBlock preview={null} busy={false} onCapture={() => {}} voice={null} aiName={null} />,
    )
  })
  return el
}

describe('the Photos button', () => {
  it('opens a picker that does not force the camera', async () => {
    const el = await render()
    const input = el.querySelector('[data-testid="photo-library-input"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.type).toBe('file')
    expect(input.accept).toBe('image/*')
    expect(input.hasAttribute('capture')).toBe(false)
  })

  it('is the input the Photos button opens', async () => {
    const el = await render()
    const input = el.querySelector('[data-testid="photo-library-input"]') as HTMLInputElement
    const clicked = vi.spyOn(input, 'click')
    const photos = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Photos')!
    await act(async () => { photos.click() })
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})
