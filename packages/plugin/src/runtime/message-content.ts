import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'

export interface ImageSource {
  readonly url?: string
  readonly data?: string
  readonly mimeType: string
}

export function extractTextFromMessages(messages: readonly UserMessage[]): string {
  return messages
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/** Read an image block regardless of whether it nests its payload under `source`. */
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
    ...(typeof source.data === 'string' ? { data: source.data } : {}),
    mimeType,
  }
}
