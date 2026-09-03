import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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
}

interface LoadedPdf {
  sourceUrl: string
  document: PDFDocumentProxy
}

interface PdfError {
  sourceUrl: string
  message: string
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
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [dimensions, setDimensions] = useState({ width: 595, height: 841 })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loadedPage = await document.getPage(pageNumber)
        if (!cancelled) setPage(loadedPage)
      } catch (loadError) {
        if (!cancelled) onError(getErrorMessage(loadError, `PDF 第 ${pageNumber} 页加载失败`))
      }
    })()
    return () => {
      cancelled = true
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
    }
  }, [availableWidth, onError, page, pageNumber, zoom])

  return (
    <div
      className="pdf-page"
      data-page-number={pageNumber}
      style={{ width: dimensions.width, height: dimensions.height }}
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
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null)
  const [pdfError, setPdfError] = useState<PdfError | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const reportError = useCallback((message: string) => {
    setPdfError({ sourceUrl, message })
  }, [sourceUrl])

  useImperativeHandle(ref, () => ({
    scrollToBlock(id) {
      const target = containerRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)
      target?.scrollIntoView({ behavior: 'auto', block: 'center' })
    },
  }))

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
      void loadingTask.destroy().catch(() => undefined)
    }
  }, [mimeType, sourceUrl])

  const document = mimeType === 'application/pdf' && loadedPdf?.sourceUrl === sourceUrl
    ? loadedPdf.document
    : null
  const error = pdfError?.sourceUrl === sourceUrl ? pdfError.message : null

  function inspectScroll() {
    const container = containerRef.current
    if (!container) return
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
    const page = containerRef.current?.querySelector<HTMLElement>(`[data-page-number="${bounded}"]`)
    page?.scrollIntoView({ behavior: 'auto', block: 'start' })
  }

  const pageBlocks = new Map<number, LinkedBlock[]>()
  blocks.forEach((block) => {
    const current = pageBlocks.get(block.pageIndex) ?? []
    current.push(block)
    pageBlocks.set(block.pageIndex, current)
  })

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
          Array.from({ length: document.numPages }, (_, index) => (
            <PageCanvas
              key={index + 1}
              document={document}
              pageNumber={index + 1}
              availableWidth={width}
              zoom={zoom}
              blocks={pageBlocks.get(index) ?? []}
              activeBlockId={activeBlockId}
              onSelectBlock={onVisibleBlock}
              onError={reportError}
            />
          ))
        )}
      </div>
    </section>
  )
})
