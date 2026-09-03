import type { ContentListV2, LinkedBlock, ParsedFileResult } from '../types'

export function isPageChromeBlockType(type: string | undefined) {
  return type === 'page_header' || type === 'page_footer' || type === 'page_number'
}

export function getParsedFile(result: { results?: Record<string, ParsedFileResult> } | null | undefined) {
  return result?.results ? Object.values(result.results)[0] : undefined
}

export function parseContentListV2(result: ParsedFileResult | undefined): ContentListV2 | null {
  if (!result?.content_list_v2) return null
  try {
    const pages = JSON.parse(result.content_list_v2) as unknown
    if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) return null
    return pages as ContentListV2
  } catch {
    return null
  }
}

export function flattenLinkedBlocks(contentList: ContentListV2 | null): LinkedBlock[] {
  if (!contentList) return []
  return contentList.flatMap((page, pageIndex) =>
    page.map((block, order) => ({
      id: `p${pageIndex}-b${order}`,
      pageIndex,
      order,
      pageSize: [1000, 1000] as [number, number],
      block,
    })),
  )
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
