import DOMPurify from 'dompurify'
import { Check, Clipboard, Download, FileArchive } from 'lucide-react'
import katex from 'katex'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

import { isPageChromeBlockType } from '../lib/mineru'
import type {
  ContentV2Block,
  ContentV2BlockContent,
  ContentV2Span,
  LinkedBlock,
  ParsedFileResult,
} from '../types'
import type { LinkedPaneHandle } from './PdfPane'

interface StructuredPaneProps {
  documentId: string
  blocks: LinkedBlock[]
  result: ParsedFileResult
  activeBlockId: string | null
  onVisibleBlock: (id: string) => void
}

function Formula({ content, display = false }: { content: string; display?: boolean }) {
  let html = content
  try {
    html = katex.renderToString(content, { displayMode: display, throwOnError: false, strict: false })
  } catch {
    // KaTeX 无法解析时保留原始公式。
  }
  return <span className={display ? 'formula-display' : 'formula-inline'} dangerouslySetInnerHTML={{ __html: html }} />
}

function SpanSequence({ spans }: { spans: ContentV2Span[] }) {
  return (
    <>
      {spans.map((span, index) => (
        span.type === 'equation_inline'
          ? <Formula key={index} content={span.content} />
          : <span key={index}>{span.content}</span>
      ))}
    </>
  )
}

function spanText(spans: ContentV2Span[] | undefined) {
  return spans?.map((span) => span.content).join('').trim() || ''
}

function primarySpans(content: ContentV2BlockContent) {
  return content.title_content
    ?? content.paragraph_content
    ?? content.page_header_content
    ?? content.page_footer_content
    ?? content.page_number_content
    ?? content.page_aside_text_content
    ?? content.page_footnote_content
    ?? []
}

function imageUrl(content: ContentV2BlockContent, images: Record<string, string>) {
  const sourcePath = content.image_source?.path
  if (!sourcePath) return undefined
  return images[sourcePath.split('/').pop() || '']
}

function VisualBlock({ block, images }: { block: ContentV2Block; images: Record<string, string> }) {
  const content = block.content
  const captions = block.type === 'table'
    ? content.table_caption ?? []
    : block.type === 'chart'
      ? content.chart_caption ?? []
      : content.image_caption ?? []
  const source = imageUrl(content, images)

  if (block.type === 'table' && content.html) {
    const safeHtml = DOMPurify.sanitize(content.html, {
      ALLOWED_TAGS: ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'br'],
      ALLOWED_ATTR: ['colspan', 'rowspan'],
    })
    return (
      <figure>
        {captions.length > 0 && <figcaption><SpanSequence spans={captions} /></figcaption>}
        <div className="document-table" dangerouslySetInnerHTML={{ __html: safeHtml }} />
      </figure>
    )
  }

  return (
    <figure>
      {source ? <img src={source} alt={spanText(captions) || '文档插图'} /> : <div className="missing-image">图片未返回</div>}
      {captions.length > 0 && <figcaption><SpanSequence spans={captions} /></figcaption>}
    </figure>
  )
}

function BlockBody({ block, images }: { block: ContentV2Block; images: Record<string, string> }) {
  const content = block.content

  if (block.type === 'title') {
    const level = Math.min(4, Math.max(1, content.level || 2))
    const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
    return <Heading><SpanSequence spans={content.title_content ?? []} /></Heading>
  }

  if (['image', 'table', 'chart'].includes(block.type)) {
    return <VisualBlock block={block} images={images} />
  }

  if (block.type === 'equation_interline') {
    return <div className="equation-block"><Formula content={content.math_content || ''} display /></div>
  }

  if (['list', 'index'].includes(block.type)) {
    const List = content.attribute === 'ordered' || block.type === 'index' ? 'ol' : 'ul'
    return (
      <List className="content-v2-list">
        {(content.list_items ?? []).map((item, index) => (
          <li key={index}><SpanSequence spans={item.item_content} /></li>
        ))}
      </List>
    )
  }

  if (['code', 'algorithm'].includes(block.type)) {
    const spans = block.type === 'code' ? content.code_content ?? [] : content.algorithm_content ?? []
    return <pre className="content-v2-code"><code><SpanSequence spans={spans} /></code></pre>
  }

  return <p><SpanSequence spans={primarySpans(content)} /></p>
}

export const StructuredPane = forwardRef<LinkedPaneHandle, StructuredPaneProps>(function StructuredPane(
  { documentId, blocks, result, activeBlockId, onVisibleBlock },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const copyTimer = useRef<number | null>(null)
  const interactionLockTimer = useRef<number | null>(null)
  const interactionLocked = useRef(false)
  const armedBlockId = useRef<string | null>(activeBlockId)
  const openMenuBlockId = useRef<string | null>(null)
  const [tab, setTab] = useState<'preview' | 'json'>('preview')
  const [copied, setCopied] = useState(false)
  const [quickMenuBlockId, setQuickMenuBlockId] = useState<string | null>(null)
  const [copiedBlockId, setCopiedBlockId] = useState<string | null>(null)
  const images = result.images ?? {}

  useEffect(() => {
    const timer = window.setTimeout(() => {
      armedBlockId.current = activeBlockId
      if (openMenuBlockId.current !== activeBlockId) {
        openMenuBlockId.current = null
        setQuickMenuBlockId(null)
      }
    })
    return () => window.clearTimeout(timer)
  }, [activeBlockId])

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    if (interactionLockTimer.current !== null) window.clearTimeout(interactionLockTimer.current)
  }, [])

  useImperativeHandle(ref, () => ({
    scrollToBlock(id) {
      if (tab !== 'preview') setTab('preview')
      openMenuBlockId.current = null
      setQuickMenuBlockId(null)
      window.setTimeout(() => {
        const target = containerRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)
        target?.scrollIntoView({ behavior: 'auto', block: 'center' })
      })
    },
  }))

  function inspectScroll() {
    const container = containerRef.current
    if (!container || tab !== 'preview') return
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      if (interactionLocked.current || openMenuBlockId.current) return
      const center = container.getBoundingClientRect().top + container.clientHeight / 2
      const elements = [...container.querySelectorAll<HTMLElement>('.markdown-block')]
      const closest = elements.reduce<{ id: string | null; distance: number }>(
        (current, element) => {
          const rect = element.getBoundingClientRect()
          const distance = Math.abs(rect.top + Math.min(rect.height, 120) / 2 - center)
          return distance < current.distance
            ? { id: element.dataset.blockId || null, distance }
            : current
        },
        { id: null, distance: Number.POSITIVE_INFINITY },
      )
      const closestElement = elements.find((element) => element.dataset.blockId === closest.id)
      if (closest.id && closestElement && !isPageChromeBlockType(closestElement.dataset.blockType)) {
        onVisibleBlock(closest.id)
      }
    })
  }

  async function copyContentListV2() {
    await navigator.clipboard.writeText(result.content_list_v2)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  function handleBlockClick(id: string) {
    interactionLocked.current = true
    if (interactionLockTimer.current !== null) window.clearTimeout(interactionLockTimer.current)
    interactionLockTimer.current = window.setTimeout(() => {
      interactionLocked.current = false
    }, 700)
    const repeatedClick = activeBlockId === id || armedBlockId.current === id
    armedBlockId.current = id
    if (repeatedClick) {
      setQuickMenuBlockId((current) => {
        const next = current === id ? null : id
        openMenuBlockId.current = next
        return next
      })
      return
    }
    openMenuBlockId.current = null
    setQuickMenuBlockId(null)
    onVisibleBlock(id)
  }

  async function copyBlock(id: string, block: ContentV2Block) {
    await navigator.clipboard.writeText(blockSourceText(block))
    setCopiedBlockId(id)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedBlockId(null), 1200)
  }

  return (
    <section className="preview-pane structured-pane">
      <header className="pane-toolbar">
        <div className="view-tabs" role="tablist">
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>预览</button>
          <button className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>JSON</button>
        </div>
        <div className="result-actions">
          <button className="icon-button" title="复制 content_list_v2" onClick={() => void copyContentListV2()}>
            {copied ? <Check size={17} /> : <Clipboard size={17} />}
          </button>
          <a
            className="icon-button"
            title="下载原始结果 ZIP"
            aria-label="下载原始结果 ZIP"
            href={`/api/documents/${documentId}/download/zip`}
            download
          >
            <FileArchive size={17} />
          </a>
          <a
            className="icon-button"
            title={tab === 'json' ? '下载 content_list_v2' : '下载 Markdown'}
            href={`/api/documents/${documentId}/download/${tab === 'json' ? 'json' : 'markdown'}`}
            download
          >
            <Download size={17} />
          </a>
        </div>
      </header>

      <div className="structured-scroll" ref={containerRef} onScroll={inspectScroll}>
        {tab === 'json' ? (
          <pre className="json-view">{formatJson(result.content_list_v2)}</pre>
        ) : blocks.length > 0 ? (
          <article className="structured-document">
            {blocks.map(({ id, block, pageIndex }) => (
              <section
                key={id}
                data-block-id={id}
                data-block-type={block.type}
                data-page-index={pageIndex}
                className={`markdown-block block-${block.type} ${activeBlockId === id ? 'active' : ''}`}
                onClick={() => handleBlockClick(id)}
              >
                <BlockBody block={block} images={images} />
                {quickMenuBlockId === id && (
                  <div className="block-quick-menu" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      aria-label={copiedBlockId === id ? '已复制' : '复制原文并保留 LaTeX'}
                      title={copiedBlockId === id ? '已复制' : '复制原文并保留 LaTeX'}
                      onClick={() => void copyBlock(id, block)}
                    >
                      {copiedBlockId === id ? <Check size={14} /> : <Clipboard size={14} />}
                    </button>
                  </div>
                )}
              </section>
            ))}
          </article>
        ) : (
          <div className="viewer-error">content_list_v2 没有可渲染的内容</div>
        )}
      </div>
    </section>
  )
})

function formatJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function spansToSource(spans: ContentV2Span[] | undefined) {
  return spans?.map((span) =>
    span.type === 'equation_inline' ? `$${span.content}$` : span.content,
  ).join('') || ''
}

function blockSourceText(block: ContentV2Block) {
  const content = block.content
  if (block.type === 'equation_interline') return `$$${content.math_content || ''}$$`
  if (['list', 'index'].includes(block.type)) {
    return (content.list_items ?? []).map((item) => spansToSource(item.item_content).trim()).join('\n')
  }
  if (block.type === 'code') return spansToSource(content.code_content).trim()
  if (block.type === 'algorithm') return spansToSource(content.algorithm_content).trim()
  return spansToSource(primarySpans(content)).trim()
    || spansToSource(content.table_caption).trim()
    || spansToSource(content.image_caption).trim()
    || spansToSource(content.chart_caption).trim()
    || content.content?.trim()
    || content.html?.trim()
    || content.image_source?.path
    || JSON.stringify(content, null, 2)
}
