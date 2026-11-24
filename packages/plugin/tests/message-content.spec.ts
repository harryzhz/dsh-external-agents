import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { readImageSource, resolveImageSource } from '../src/runtime/message-content.js'

function makeMockCtx(attachments?: {
  readImage?: ReturnType<typeof vi.fn>
  imageHostPath?: ReturnType<typeof vi.fn>
}): Context {
  return {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    get: (key: string) => (key === 'attachments' ? attachments : undefined),
  } as unknown as Context
}

describe('External runtime image block resolution', () => {
  it('resolves durable DSH ImageBlock attachments via ctx.attachments.readImage for base64 consumers (ACP)', async () => {
    const rawBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const readImage = vi.fn().mockResolvedValue({
      data: rawBytes,
      ref: { mediaType: 'image/png' },
    })
    const imageHostPath = vi.fn().mockReturnValue('/tmp/attachments/img-1.png')
    const ctx = makeMockCtx({ readImage, imageHostPath })

    const block = {
      type: 'image',
      attachment: {
        attachmentId: 'sha256:abcdef123456',
        mediaType: 'image/png',
        bytes: rawBytes.byteLength,
        width: 100,
        height: 80,
      },
    } as unknown as ContentBlock

    const resolved = await resolveImageSource(ctx, block)
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(resolved).toEqual({
      path: '/tmp/attachments/img-1.png',
      data: Buffer.from(rawBytes).toString('base64'),
      mimeType: 'image/png',
    })
  })

  it('prefers host path without reading bytes when preferHostPath is set (Codex localImage)', async () => {
    const readImage = vi.fn()
    const imageHostPath = vi.fn().mockReturnValue('/tmp/attachments/img-2.jpg')
    const ctx = makeMockCtx({ readImage, imageHostPath })

    const block = {
      type: 'image',
      attachment: {
        attachmentId: 'sha256:999999',
        mediaType: 'image/jpeg',
        bytes: 1234,
        width: 200,
        height: 150,
      },
    } as unknown as ContentBlock

    const resolved = await resolveImageSource(ctx, block, { preferHostPath: true })
    expect(readImage).not.toHaveBeenCalled()
    expect(resolved).toEqual({
      path: '/tmp/attachments/img-2.jpg',
      mimeType: 'image/jpeg',
    })
  })

  it('falls back to readImage base64 when preferHostPath is set but imageHostPath returns undefined', async () => {
    const rawBytes = Uint8Array.from([0xff, 0xd8, 0xff])
    const readImage = vi.fn().mockResolvedValue({
      data: rawBytes,
      ref: { mediaType: 'image/jpeg' },
    })
    const imageHostPath = vi.fn().mockReturnValue(undefined)
    const ctx = makeMockCtx({ readImage, imageHostPath })

    const block = {
      type: 'image',
      attachment: {
        attachmentId: 'sha256:888888',
        mediaType: 'image/jpeg',
        bytes: rawBytes.byteLength,
        width: 50,
        height: 50,
      },
    } as unknown as ContentBlock

    const resolved = await resolveImageSource(ctx, block, { preferHostPath: true })
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(resolved).toEqual({
      data: Buffer.from(rawBytes).toString('base64'),
      mimeType: 'image/jpeg',
    })
  })

  it('skips offloaded image blocks and degrades gracefully when attachment reads fail', async () => {
    const readImage = vi.fn().mockRejectedValue(new Error('attachment missing'))
    const ctx = makeMockCtx({ readImage })

    const offloadedBlock = {
      type: 'image',
      offloaded: true,
      attachment: { attachmentId: 'sha256:000', mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
    } as unknown as ContentBlock
    expect(await resolveImageSource(ctx, offloadedBlock)).toEqual({ mimeType: 'image/png' })
    expect(readImage).not.toHaveBeenCalled()

    const brokenBlock = {
      type: 'image',
      attachment: { attachmentId: 'sha256:bad', mediaType: 'image/webp', bytes: 10, width: 1, height: 1 },
    } as unknown as ContentBlock
    expect(await resolveImageSource(ctx, brokenBlock)).toEqual({ mimeType: 'image/webp' })
  })

  it('retains backward compatibility with legacy inline base64 and URL image blocks', async () => {
    const ctx = makeMockCtx()
    const inlineBlock = {
      type: 'image',
      mediaType: 'image/gif',
      data: 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=',
    } as unknown as ContentBlock

    expect(readImageSource(inlineBlock)).toEqual({
      data: 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=',
      mimeType: 'image/gif',
    })
    expect(await resolveImageSource(ctx, inlineBlock)).toEqual({
      data: 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=',
      mimeType: 'image/gif',
    })
  })
})
