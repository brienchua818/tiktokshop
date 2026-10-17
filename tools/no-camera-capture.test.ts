/**
 * No file picker in the app forces the camera.
 *
 * Brien, 17 Oct, on an iPhone: "Photos" opened the camera. Its input carried
 * `capture="environment"`, which tells the phone to skip the photo library, and
 * iOS obeys it. Checked across every source file, because a second picker added
 * with the same attribute would break the same way on every iPhone.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx$/.test(path) && !/\.test\.tsx$/.test(path)) out.push(path)
  }
  return out
}

describe('file pickers', () => {
  it('none sets a capture attribute', () => {
    const files = sources(SRC)
    expect(files.length).toBeGreaterThan(10)
    const hits: string[] = []
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*capture=/.test(line) || /<input\b[^>]*\scapture=/.test(line)) hits.push(`${file}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
  })
})
