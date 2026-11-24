import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'

export interface ImageSource {
  readonly url?: string
  readonly path?: string
  readonly data?: string
  readonly mimeType: string
}

interface HostImageAttachmentStore {
  readImage?(
    ref: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly data: Uint8Array; readonly ref?: { readonly mediaType?: string } }>
  imageHostPath?(ref: unknown): string | undefined
}

export function extractTextFromMessages(messages: readonly UserMessage[]): string {
  return messages
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/** Read an inline/legacy image block regardless of whether it nests its payload under `source`. */
export function readImageSource(block: ContentBlock): ImageSource {
  const rec = block as unknown as Record<string, unknown>
  const source = (rec.source && typeof rec.source === 'object' ? rec.source : rec) as Record<string, unknown>
  const mimeType =
    typeof source.mediaType === 'string'
      ? source.mediaType
      : typeof source.mimeType === 'string'
        ? source.mimeType
        : 'image/png'
  return {
    ...(typeof source.url === 'string' ? { url: source.url } : {}),
    ...(typeof source.path === 'string' ? { path: source.path } : {}),
    ...(typeof source.data === 'string' ? { data: source.data } : {}),
    mimeType,
  }
}

/**
 * Resolve both DSH durable `ImageBlock` (`{ type: 'image', attachment }`) via host `ctx.attachments`
 * and legacy inline image payloads (`url` / `path` / `data`).
 */
export async function resolveImageSource(
  ctx: Context,
  block: ContentBlock,
  options: { readonly signal?: AbortSignal; readonly preferHostPath?: boolean } = {},
): Promise<ImageSource> {
  const rec = block as unknown as Record<string, unknown>
  if (rec.offloaded === true) {
    return { mimeType: 'image/png' }
  }

  const attachment = rec.attachment
  if (attachment && typeof attachment === 'object') {
    const attRec = attachment as Record<string, unknown>
    const fallbackMime =
      typeof attRec.mediaType === 'string' && attRec.mediaType.trim()
        ? attRec.mediaType.trim()
        : 'image/png'
    const store = ctx.get('attachments' as never) as HostImageAttachmentStore | undefined

    let hostPath: string | undefined
    if (typeof store?.imageHostPath === 'function') {
      try {
        const candidate = store.imageHostPath(attachment)
        if (typeof candidate === 'string' && candidate.trim()) {
          hostPath = candidate.trim()
        }
      } catch (err) {
        ctx.logger?.warn?.(
          `[dsh-external-agents] failed to resolve image host path: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (options.preferHostPath && hostPath) {
      return { path: hostPath, mimeType: fallbackMime }
    }

    if (typeof store?.readImage === 'function') {
      try {
        const stored = await store.readImage(attachment, options.signal)
        const mimeType =
          typeof stored.ref?.mediaType === 'string' && stored.ref.mediaType.trim()
            ? stored.ref.mediaType.trim()
            : fallbackMime
        const data = Buffer.from(stored.data).toString('base64')
        return {
          ...(hostPath ? { path: hostPath } : {}),
          ...(data ? { data } : {}),
          mimeType,
        }
      } catch (err) {
        ctx.logger?.warn?.(
          `[dsh-external-agents] failed to read image attachment: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    return {
      ...(hostPath ? { path: hostPath } : {}),
      mimeType: fallbackMime,
    }
  }

  return readImageSource(block)
}
