import type {
  ContentListV2,
  ContentV2Block,
  ContentV2BlockContent,
  ContentV2Span,
  LinkedBlock,
  MarkdownLineRange,
  ParsedFileResult,
} from '../types'

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

function spansToText(spans: ContentV2Span[] | undefined) {
  return spans?.map((span) => span.content).join('') || ''
}

function primaryBlockText(content: ContentV2BlockContent) {
  return spansToText(
    content.title_content
      ?? content.paragraph_content
      ?? content.page_header_content
      ?? content.page_footer_content
      ?? content.page_number_content
      ?? content.page_aside_text_content
      ?? content.page_footnote_content,
  )
}

function contentText(spans: ContentV2Span[] | undefined) {
  return normalizeMarkdownLine(spansToText(spans))
}

function blockMarkdownCandidates(block: ContentV2Block) {
  const content = block.content
  const candidates: string[] = []

  if (block.type === 'equation_interline') {
    candidates.push(normalizeMarkdownLine(content.math_content || ''))
  } else if (['list', 'index'].includes(block.type)) {
    candidates.push((content.list_items ?? []).map((item) => contentText(item.item_content)).join(''))
  } else if (block.type === 'code') {
    candidates.push(contentText(content.code_content))
  } else if (block.type === 'algorithm') {
    candidates.push(contentText(content.algorithm_content))
  } else {
    candidates.push(normalizeMarkdownLine(primaryBlockText(content)))
  }

  if (['image', 'table', 'chart'].includes(block.type)) {
    candidates.push(
      contentText(content.table_caption)
        || contentText(content.image_caption)
        || contentText(content.chart_caption),
    )
    if (content.image_source?.path) candidates.push(normalizeMarkdownLine(content.image_source.path))
  }
  if (block.type === 'table' && content.html) {
    candidates.push(normalizeMarkdownLine(content.html.replace(/<[^>]+>/g, ' ')))
  }

  return candidates.filter((candidate) => candidate.length >= 3)
}

function normalizeMarkdownLine(line: string) {
  return line
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1$2')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
    .replace(/\\(?=[^a-zA-Z\s])/g, '')
    .replace(/[`*_~$]/g, '')
    .replace(/\s+/g, '')
}

function markdownSearchIndex(markdown: string) {
  const characters: string[] = []
  const lineNumbers: number[] = []
  markdown.replace(/\r\n?/g, '\n').split('\n').forEach((line, lineIndex) => {
    const normalized = normalizeMarkdownLine(line)
    for (const character of normalized) {
      characters.push(character)
      lineNumbers.push(lineIndex + 1)
    }
  })
  return { text: characters.join(''), lineNumbers }
}

export function getMarkdownLineCount(markdown: string | undefined) {
  if (!markdown) return 0
  return markdown.replace(/\r\n?/g, '\n').split('\n').length
}

export function buildMarkdownLineMap(markdown: string | undefined, blocks: LinkedBlock[]) {
  const lineMap = new Map<string, MarkdownLineRange>()
  if (!markdown) return lineMap

  const index = markdownSearchIndex(markdown)
  let cursor = 0
  blocks.forEach((linkedBlock) => {
    if (isPageChromeBlockType(linkedBlock.block.type)) return

    const match = blockMarkdownCandidates(linkedBlock.block)
      .map((candidate) => ({ candidate, start: index.text.indexOf(candidate, cursor) }))
      .filter(({ start }) => start >= 0)
      .sort((left, right) => right.candidate.length - left.candidate.length)[0]

    if (!match) return
    const endIndex = match.start + match.candidate.length - 1
    lineMap.set(linkedBlock.id, {
      start: index.lineNumbers[match.start],
      end: index.lineNumbers[endIndex],
    })
    cursor = endIndex + 1
  })
  return lineMap
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
