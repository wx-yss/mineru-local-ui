import { FileClock, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { flattenLinkedBlocks, getParsedFile, parseContentListV2 } from '../lib/mineru'
import type { DocumentDetail } from '../types'
import { PdfPane } from './PdfPane'
import type { LinkedPaneHandle } from './PdfPane'
import { StructuredPane } from './StructuredPane'

interface DocumentViewerProps {
  document: DocumentDetail
  onRetry: () => void
}

export function DocumentViewer({ document, onRetry }: DocumentViewerProps) {
  const pdfRef = useRef<LinkedPaneHandle>(null)
  const structuredRef = useRef<LinkedPaneHandle>(null)
  const syncLock = useRef(false)
  const syncTimer = useRef<number | null>(null)
  const parsedFile = getParsedFile(document.result)
  const contentListV2 = useMemo(() => parseContentListV2(parsedFile), [parsedFile])
  const blocks = useMemo(() => flattenLinkedBlocks(contentListV2), [contentListV2])
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const effectiveActiveBlockId = activeBlockId ?? blocks[0]?.id ?? null

  useEffect(() => () => {
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current)
  }, [])

  function synchronize(source: 'pdf' | 'markdown', id: string) {
    if (syncLock.current || id === effectiveActiveBlockId) return
    setActiveBlockId(id)
    syncLock.current = true
    if (source === 'pdf') structuredRef.current?.scrollToBlock(id)
    else pdfRef.current?.scrollToBlock(id)
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => {
      syncLock.current = false
    }, 120)
  }

  return (
    <main className="viewer-shell">
      {document.status === 'failed' ? (
        <div className="task-state error-state">
          <FileClock size={34} />
          <h2>解析未完成</h2>
          <p>{document.error || 'MinerU 返回了解析错误'}</p>
          <button className="primary-button" onClick={onRetry}><RefreshCw size={17} />重新提交</button>
        </div>
      ) : document.status !== 'completed' || !parsedFile ? (
        <div className="task-state processing-state">
          <span className="processing-indicator"><RefreshCw size={25} className="spin" /></span>
          <h2>{document.status === 'pending' ? '任务正在排队' : 'MinerU 正在解析文档'}</h2>
          <p>完成后将自动打开联动预览</p>
          <div className="progress-track"><span /></div>
        </div>
      ) : (
        <div className="linked-viewer">
          <PdfPane
            key={document.id}
            ref={pdfRef}
            sourceUrl={`/api/documents/${document.id}/source`}
            mimeType={document.mimeType}
            blocks={blocks}
            activeBlockId={effectiveActiveBlockId}
            onVisibleBlock={(id) => synchronize('pdf', id)}
          />
          <StructuredPane
            ref={structuredRef}
            documentId={document.id}
            blocks={blocks}
            result={parsedFile}
            activeBlockId={effectiveActiveBlockId}
            onVisibleBlock={(id) => synchronize('markdown', id)}
          />
        </div>
      )}
    </main>
  )
}
