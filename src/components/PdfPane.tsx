import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { isPageChromeBlockType } from '../lib/mineru'
import type { LinkedBlock } from '../types'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export interface LinkedPaneHandle {
  scrollToBlock: (id: string) => void
}

interface PdfPaneProps {
  sourceUrl: string
  mimeType: string
  blocks: LinkedBlock[]
  activeBlockId: string | null
  onVisibleBlock: (id: string) => void
}

interface PageCanvasProps {
  document: PDFDocumentProxy
  pageNumber: number
  availableWidth: number
  zoom: number
  blocks: LinkedBlock[]
  activeBlockId: string | null
  onSelectBlock: (id: string) => void
  onError: (message: string) => void
  estimatedWidth: number
  estimatedHeight: number
  onPageDimensions: (pageIndex: number, height: number) => void
}

interface LoadedPdf {
  sourceUrl: string
  document: PDFDocumentProxy
}

interface PdfError {
  sourceUrl: string
  message: string
}

interface PageRange {
  start: number
  end: number
}

interface PendingScroll {
  requestId: number
  pageNumber: number
  blockId?: string
}

interface IdleDeadlineLike {
  didTimeout: boolean
  timeRemaining: () => number
}

type IdleCallback = (deadline: IdleDeadlineLike) => void

interface IdleWindow {
  requestIdleCallback?: (callback: IdleCallback, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

const immediatePageAhead = 1
const idlePageAhead = 4
const idleTimeout = 500
const pageMargin = 22
const defaultPageSize = { width: 595, height: 841 }

class PageLayout {
  private readonly estimatedExtent: number
  private readonly pageCount: number
  private readonly tree: number[]
  private readonly measuredExtents = new Map<number, number>()

  constructor(pageCount: number, estimatedExtent: number) {
    this.pageCount = pageCount
    this.estimatedExtent = estimatedExtent
    this.tree = Array.from({ length: pageCount + 1 }, () => 0)
  }

  setPageHeight(pageIndex: number, height: number) {
    if (pageIndex < 0 || pageIndex >= this.pageCount) return false
    const nextExtent = height + pageMargin
    const previousExtent = this.measuredExtents.get(pageIndex)
    if (previousExtent === nextExtent) return false

    const previousDelta = previousExtent === undefined ? 0 : previousExtent - this.estimatedExtent
    const nextDelta = nextExtent - this.estimatedExtent
    this.measuredExtents.set(pageIndex, nextExtent)
    this.addDelta(pageIndex, nextDelta - previousDelta)
    return true
  }

  offsetBefore(pageIndex: number) {
    const bounded = Math.max(0, Math.min(pageIndex, this.pageCount))
    return bounded * this.estimatedExtent + this.sumDeltas(bounded)
  }

  totalHeight() {
    return this.offsetBefore(this.pageCount)
  }

  pageAtOffset(offset: number) {
    if (this.pageCount <= 0) return 0
    const boundedOffset = Math.max(0, Math.min(offset, Math.max(0, this.totalHeight() - 1)))
    let lower = 0
    let upper = this.pageCount
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (this.offsetBefore(middle) <= boundedOffset) lower = middle + 1
      else upper = middle
    }
    return Math.max(0, Math.min(lower - 1, this.pageCount - 1))
  }

  private addDelta(pageIndex: number, delta: number) {
    for (let index = pageIndex + 1; index <= this.pageCount; index += index & -index) {
      this.tree[index] += delta
    }
  }

  private sumDeltas(pageCount: number) {
    let total = 0
    for (let index = pageCount; index > 0; index -= index & -index) {
      total += this.tree[index]
    }
    return total
  }
}

function scheduleIdle(callback: IdleCallback) {
  const idleWindow = window as IdleWindow
  if (idleWindow.requestIdleCallback) {
    return idleWindow.requestIdleCallback(callback, { timeout: idleTimeout })
  }
  return window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), idleTimeout)
}

function cancelIdle(handle: number) {
  const idleWindow = window as IdleWindow
  if (idleWindow.cancelIdleCallback) {
    idleWindow.cancelIdleCallback(handle)
    return
  }
  window.clearTimeout(handle)
}

function estimatePageDimensions(availableWidth: number, zoom: number) {
  if (availableWidth <= 0) return defaultPageSize
  const fitScale = Math.max(0.35, (availableWidth - 48) / defaultPageSize.width)
  const scale = fitScale * zoom
  return {
    width: defaultPageSize.width * scale,
    height: defaultPageSize.height * scale,
  }
}

function clampPageRange(start: number, end: number, pageCount: number): PageRange {
  if (pageCount <= 0) return { start: 0, end: -1 }
  return {
    start: Math.max(0, Math.min(start, pageCount - 1)),
    end: Math.max(0, Math.min(end, pageCount - 1)),
  }
}

function pageRangeForTarget(pageIndex: number, pageCount: number) {
  return clampPageRange(pageIndex - immediatePageAhead, pageIndex + immediatePageAhead, pageCount)
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function PageCanvas({
  document,
  pageNumber,
  availableWidth,
  zoom,
  blocks,
  activeBlockId,
  onSelectBlock,
  onError,
  estimatedWidth,
  estimatedHeight,
  onPageDimensions,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const displayDimensions = dimensions ?? { width: estimatedWidth, height: estimatedHeight }

  useEffect(() => {
    let cancelled = false
    let loadedPage: PDFPageProxy | null = null
    void (async () => {
      try {
        loadedPage = await document.getPage(pageNumber)
        if (!cancelled) setPage(loadedPage)
        else loadedPage.cleanup()
      } catch (loadError) {
        if (!cancelled) onError(getErrorMessage(loadError, `PDF 第 ${pageNumber} 页加载失败`))
      }
    })()
    return () => {
      cancelled = true
      loadedPage?.cleanup()
    }
  }, [document, onError, pageNumber])

  useEffect(() => {
    if (!page || !canvasRef.current || availableWidth <= 0) return
    const baseViewport = page.getViewport({ scale: 1 })
    const fitScale = Math.max(0.35, (availableWidth - 48) / baseViewport.width)
    const viewport = page.getViewport({ scale: fitScale * zoom })
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    if (!context) return

    renderTaskRef.current?.cancel()
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(viewport.width * pixelRatio)
    canvas.height = Math.floor(viewport.height * pixelRatio)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    setDimensions({ width: viewport.width, height: viewport.height })
    onPageDimensions(pageNumber - 1, viewport.height)

    let cancelled = false
    let renderTask
    try {
      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      })
    } catch (renderError) {
      onError(getErrorMessage(renderError, `PDF 第 ${pageNumber} 页渲染失败`))
      return
    }
    renderTaskRef.current = renderTask
    void renderTask.promise.catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === 'RenderingCancelledException')) return
      onError(getErrorMessage(error, `PDF 第 ${pageNumber} 页渲染失败`))
    })

    return () => {
      cancelled = true
      renderTask.cancel()
      page.cleanup()
      void renderTask.promise.finally(() => page.cleanup()).catch(() => undefined)
    }
  }, [availableWidth, onError, onPageDimensions, page, pageNumber, zoom])

  return (
    <div
      className="pdf-page"
      data-page-number={pageNumber}
      style={{ width: displayDimensions.width, height: displayDimensions.height }}
    >
      <canvas ref={canvasRef} />
      <div className="pdf-overlay-layer">
        {blocks.map(({ id, block, pageSize }) => {
          const [x0, y0, x1, y1] = block.bbox
          return (
            <button
              key={id}
              type="button"
              data-block-id={id}
              data-block-type={block.type}
              aria-label={`定位解析块 ${id}`}
              className={`pdf-block-overlay ${isPageChromeBlockType(block.type) ? 'page-chrome' : ''} ${activeBlockId === id ? 'active' : ''}`}
              style={{
                left: `${(x0 / pageSize[0]) * 100}%`,
                top: `${(y0 / pageSize[1]) * 100}%`,
                width: `${Math.max(0.8, ((x1 - x0) / pageSize[0]) * 100)}%`,
                height: `${Math.max(0.5, ((y1 - y0) / pageSize[1]) * 100)}%`,
              }}
              onClick={() => onSelectBlock(id)}
            />
          )
        })}
      </div>
    </div>
  )
}

export const PdfPane = forwardRef<LinkedPaneHandle, PdfPaneProps>(function PdfPane(
  { sourceUrl, mimeType, blocks, activeBlockId, onVisibleBlock },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const idleRenderHandle = useRef<number | null>(null)
  const idleRenderGeneration = useRef(0)
  const renderRangeRef = useRef<PageRange>({ start: 0, end: -1 })
  const pendingScrollId = useRef(0)
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null)
  const [pdfError, setPdfError] = useState<PdfError | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [renderRange, setRenderRange] = useState<PageRange>({ start: 0, end: -1 })
  const [pendingScroll, setPendingScroll] = useState<PendingScroll | null>(null)
  const [, setPageLayoutVersion] = useState(0)
  const reportError = useCallback((message: string) => {
    setPdfError({ sourceUrl, message })
  }, [sourceUrl])
  const document = mimeType === 'application/pdf' && loadedPdf?.sourceUrl === sourceUrl
    ? loadedPdf.document
    : null
  const error = pdfError?.sourceUrl === sourceUrl ? pdfError.message : null

  const pageBlocks = useMemo(() => {
    const grouped = new Map<number, LinkedBlock[]>()
    blocks.forEach((block) => {
      const current = grouped.get(block.pageIndex) ?? []
      current.push(block)
      grouped.set(block.pageIndex, current)
    })
    return grouped
  }, [blocks])

  const blockPageById = useMemo(() => new Map(blocks.map((block) => [block.id, block.pageIndex])), [blocks])
  const estimatedDimensions = useMemo(() => estimatePageDimensions(width, zoom), [width, zoom])
  const estimatedPageExtent = estimatedDimensions.height + pageMargin
  const pageLayout = useMemo(
    () => new PageLayout(document?.numPages ?? 0, estimatedPageExtent),
    [document, estimatedPageExtent],
  )

  const onPageDimensions = useCallback((pageIndex: number, height: number) => {
    if (!pageLayout.setPageHeight(pageIndex, height)) return
    setPageLayoutVersion((version) => version + 1)
  }, [pageLayout])

  const pageRangeAtScroll = useCallback((ahead: number): PageRange => {
    const container = containerRef.current
    if (!container || !document) return { start: 0, end: -1 }
    const firstVisiblePage = pageLayout.pageAtOffset(container.scrollTop)
    const lastVisiblePage = pageLayout.pageAtOffset(container.scrollTop + container.clientHeight - 1)
    return clampPageRange(firstVisiblePage - ahead, lastVisiblePage + ahead, document.numPages)
  }, [document, pageLayout])

  const setPageRenderRange = useCallback((nextRange: PageRange) => {
    const currentRange = renderRangeRef.current
    if (currentRange.start === nextRange.start && currentRange.end === nextRange.end) return
    renderRangeRef.current = nextRange
    setRenderRange(nextRange)
  }, [])

  const cancelIdleRender = useCallback(() => {
    if (idleRenderHandle.current !== null) {
      cancelIdle(idleRenderHandle.current)
      idleRenderHandle.current = null
    }
    idleRenderGeneration.current += 1
  }, [])

  const updatePageRenderRange = useCallback((scheduleNearbyPages: boolean) => {
    const immediateRange = pageRangeAtScroll(immediatePageAhead)
    setPageRenderRange(immediateRange)
    if (!scheduleNearbyPages) return

    cancelIdleRender()
    const idleRange = pageRangeAtScroll(idlePageAhead)
    const generation = idleRenderGeneration.current
    idleRenderHandle.current = scheduleIdle(() => {
      if (generation !== idleRenderGeneration.current) return
      idleRenderHandle.current = null
      setPageRenderRange(idleRange)
    })
  }, [cancelIdleRender, pageRangeAtScroll, setPageRenderRange])

  useImperativeHandle(ref, () => ({
    scrollToBlock(id) {
      const pageIndex = blockPageById.get(id)
      if (pageIndex === undefined) return
      setPageRenderRange(pageRangeForTarget(pageIndex, document?.numPages ?? 0))
      setPendingScroll({ requestId: pendingScrollId.current += 1, pageNumber: pageIndex + 1, blockId: id })
    },
  }), [blockPageById, document, setPageRenderRange])

  useEffect(() => {
    if (!document || width <= 0) return
    updatePageRenderRange(true)
  }, [document, updatePageRenderRange, width, zoom])

  useEffect(() => {
    if (!pendingScroll || !document) return
    const targetPageIndex = pendingScroll.pageNumber - 1
    if (targetPageIndex < renderRange.start || targetPageIndex > renderRange.end) {
      setPageRenderRange(pageRangeForTarget(targetPageIndex, document.numPages))
      return
    }
    const selector = pendingScroll.blockId
      ? `[data-block-id="${CSS.escape(pendingScroll.blockId)}"]`
      : `[data-page-number="${pendingScroll.pageNumber}"]`
    const target = containerRef.current?.querySelector<HTMLElement>(selector)
    if (!target) return
    setPendingScroll(null)
    target.scrollIntoView({ behavior: 'auto', block: pendingScroll.blockId ? 'center' : 'start' })
  }, [document, pendingScroll, renderRange, setPageRenderRange])

  useLayoutEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (mimeType !== 'application/pdf') return
    let cancelled = false
    const loadingTask = pdfjs.getDocument({
      url: sourceUrl,
      wasmUrl: `${import.meta.env.BASE_URL}pdfjs-wasm/`,
    })
    void loadingTask.promise
      .then((loadedDocument) => {
        if (!cancelled) {
          setLoadedPdf({ sourceUrl, document: loadedDocument })
          setPdfError(null)
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setPdfError({ sourceUrl, message: getErrorMessage(loadError, 'PDF 加载失败') })
        }
      })
    return () => {
      cancelled = true
      cancelIdleRender()
      void loadingTask.destroy().catch(() => undefined)
    }
  }, [cancelIdleRender, mimeType, sourceUrl])

  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    cancelIdleRender()
  }, [cancelIdleRender])

  function inspectScroll() {
    const container = containerRef.current
    if (!container) return
    updatePageRenderRange(true)
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      const center = container.getBoundingClientRect().top + container.clientHeight / 2
      const pages = [...container.querySelectorAll<HTMLElement>('.pdf-page')]
      const closestPage = pages.reduce<{ page: HTMLElement | null; distance: number }>(
        (closest, page) => {
          const rect = page.getBoundingClientRect()
          const distance = Math.abs(rect.top + rect.height / 2 - center)
          return distance < closest.distance ? { page, distance } : closest
        },
        { page: null, distance: Number.POSITIVE_INFINITY },
      )
      if (closestPage.page) setCurrentPage(Number(closestPage.page.dataset.pageNumber || 1))

      const overlays = [...container.querySelectorAll<HTMLElement>('.pdf-block-overlay')]
      const closestBlock = overlays.reduce<{ id: string | null; distance: number }>(
        (closest, overlay) => {
          const rect = overlay.getBoundingClientRect()
          const distance = Math.abs(rect.top + rect.height / 2 - center)
          return distance < closest.distance
            ? { id: overlay.dataset.blockId || null, distance }
            : closest
        },
        { id: null, distance: Number.POSITIVE_INFINITY },
      )
      const closestOverlay = overlays.find((overlay) => overlay.dataset.blockId === closestBlock.id)
      if (closestBlock.id && closestOverlay && !isPageChromeBlockType(closestOverlay.dataset.blockType)) {
        onVisibleBlock(closestBlock.id)
      }
    })
  }

  function goToPage(pageNumber: number) {
    const bounded = Math.max(1, Math.min(document?.numPages || 1, pageNumber))
    setPageRenderRange(pageRangeForTarget(bounded - 1, document?.numPages ?? 0))
    setPendingScroll({ requestId: pendingScrollId.current += 1, pageNumber: bounded })
  }

  return (
    <section className="preview-pane pdf-pane">
      <header className="pane-toolbar">
        <span className="pane-title">原文件</span>
        {document && (
          <div className="pdf-controls">
            <button className="icon-button" title="上一页" onClick={() => goToPage(currentPage - 1)}>
              <ChevronLeft size={17} />
            </button>
            <span className="page-counter">{currentPage} / {document.numPages}</span>
            <button className="icon-button" title="下一页" onClick={() => goToPage(currentPage + 1)}>
              <ChevronRight size={17} />
            </button>
            <span className="toolbar-divider" />
            <button className="icon-button" title="缩小" onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}>
              <Minus size={16} />
            </button>
            <span className="zoom-label">{Math.round(zoom * 100)}%</span>
            <button className="icon-button" title="放大" onClick={() => setZoom((value) => Math.min(2, value + 0.1))}>
              <Plus size={16} />
            </button>
          </div>
        )}
      </header>

      <div className="pdf-scroll" ref={containerRef} onScroll={inspectScroll}>
        {error && <div className="viewer-error">{error}</div>}
        {mimeType.startsWith('image/') ? (
          <div className="image-source-preview"><img src={sourceUrl} alt="原始上传文件" /></div>
        ) : !document ? (
          <div className="viewer-loading">正在加载原文件...</div>
        ) : (
          <>
            <div
              className="pdf-page-spacer"
              style={{ height: pageLayout.offsetBefore(renderRange.start) }}
              aria-hidden="true"
            />
            {Array.from({ length: Math.max(0, renderRange.end - renderRange.start + 1) }, (_, index) => {
              const pageIndex = renderRange.start + index
              return (
                <PageCanvas
                  key={pageIndex + 1}
                  document={document}
                  pageNumber={pageIndex + 1}
                  availableWidth={width}
                  zoom={zoom}
                  blocks={pageBlocks.get(pageIndex) ?? []}
                  activeBlockId={activeBlockId}
                  onSelectBlock={onVisibleBlock}
                  onError={reportError}
                  estimatedWidth={estimatedDimensions.width}
                  estimatedHeight={estimatedDimensions.height}
                  onPageDimensions={onPageDimensions}
                />
              )
            })}
            <div
              className="pdf-page-spacer"
              style={{
                height: Math.max(0, pageLayout.totalHeight() - pageLayout.offsetBefore(renderRange.end + 1)),
              }}
              aria-hidden="true"
            />
          </>
        )}
      </div>
    </section>
  )
})
