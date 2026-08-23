import { useCallback, useEffect, useState } from 'react'

import './App.css'
import { deleteDocument, getDocument, getHealth, listDocuments, retryDocument, uploadDocument } from './api'
import { DocumentViewer } from './components/DocumentViewer'
import { Sidebar } from './components/Sidebar'
import { UploadView } from './components/UploadView'
import {
  loadMineruEndpoints,
  loadSelectedEndpointId,
  saveMineruEndpoints,
  saveSelectedEndpointId,
  serverDefaultEndpoint,
} from './lib/mineruEndpoints'
import type { DocumentDetail, DocumentMeta, HealthState, MineruEndpoint, ParseOptions } from './types'

function App() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeDocument, setActiveDocument] = useState<DocumentDetail | null>(null)
  const [health, setHealth] = useState<HealthState | null>(null)
  const [customEndpoints, setCustomEndpoints] = useState<MineruEndpoint[]>(loadMineruEndpoints)
  const [selectedEndpointId, setSelectedEndpointId] = useState(loadSelectedEndpointId)
  const [serverDefaultUrl, setServerDefaultUrl] = useState('http://127.0.0.1:8000')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endpoints = [serverDefaultEndpoint, ...customEndpoints]
  const selectedEndpoint = endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? serverDefaultEndpoint
  const selectedMineruApiUrl = selectedEndpoint.url

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await listDocuments())
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '无法读取文件目录')
    }
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      const nextHealth = await getHealth(selectedMineruApiUrl)
      setHealth(nextHealth)
      if (!selectedMineruApiUrl) setServerDefaultUrl(nextHealth.url)
    } catch {
      setHealth({ available: false, url: selectedMineruApiUrl || serverDefaultUrl })
    }
  }, [selectedMineruApiUrl, serverDefaultUrl])

  const refreshActiveDocument = useCallback(async (id: string) => {
    try {
      const detail = await getDocument(id)
      setActiveDocument(detail)
      return detail
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : '无法读取解析结果')
      return null
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void refreshDocuments()
      void refreshHealth()
    })
    const healthTimer = window.setInterval(() => void refreshHealth(), 5000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(healthTimer)
    }
  }, [refreshDocuments, refreshHealth])

  useEffect(() => {
    try {
      saveMineruEndpoints(customEndpoints)
      saveSelectedEndpointId(selectedEndpoint.id)
    } catch {
      // 浏览器禁用本地存储时仍允许当前页面使用服务地址。
    }
  }, [customEndpoints, selectedEndpoint.id])

  useEffect(() => {
    if (!activeId) return
    const timer = window.setTimeout(() => void refreshActiveDocument(activeId))
    return () => window.clearTimeout(timer)
  }, [activeId, refreshActiveDocument])

  useEffect(() => {
    const hasRunningTask = documents.some((document) =>
      ['submitting', 'pending', 'processing'].includes(document.status),
    )
    if (!hasRunningTask) return
    const timer = window.setInterval(async () => {
      await refreshDocuments()
      if (activeId) await refreshActiveDocument(activeId)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [activeId, documents, refreshActiveDocument, refreshDocuments])

  async function handleUpload(file: File, options: ParseOptions) {
    setUploading(true)
    setError(null)
    try {
      const document = await uploadDocument(file, {
        ...options,
        mineruApiUrl: selectedMineruApiUrl || serverDefaultUrl,
      })
      await refreshDocuments()
      setActiveId(document.id)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '文件上传失败')
    } finally {
      setUploading(false)
    }
  }

  function handleAddEndpoint(endpoint: MineruEndpoint) {
    setCustomEndpoints((current) => [
      ...current.filter((item) => item.url !== endpoint.url),
      endpoint,
    ])
    setSelectedEndpointId(endpoint.id)
  }

  function handleDeleteEndpoint(id: string) {
    setCustomEndpoints((current) => current.filter((endpoint) => endpoint.id !== id))
    if (selectedEndpointId === id) setSelectedEndpointId(serverDefaultEndpoint.id)
  }

  async function handleDelete(document: DocumentMeta) {
    if (!window.confirm(`删除“${document.name}”及其本地解析结果？`)) return
    try {
      await deleteDocument(document.id)
      if (activeId === document.id) {
        setActiveId(null)
        setActiveDocument(null)
      }
      await refreshDocuments()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败')
    }
  }

  async function handleRetry() {
    if (!activeDocument) return
    setError(null)
    try {
      await retryDocument(activeDocument.id, activeDocument.options)
      await refreshDocuments()
      await refreshActiveDocument(activeDocument.id)
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : '重新提交失败')
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        documents={documents}
        activeId={activeId}
        health={health}
        endpoints={endpoints}
        selectedEndpointId={selectedEndpoint.id}
        serverDefaultUrl={serverDefaultUrl}
        onNew={() => {
          setActiveId(null)
          setActiveDocument(null)
          setError(null)
        }}
        onSelect={(id) => {
          setActiveId(id)
          setError(null)
        }}
        onDelete={(document) => void handleDelete(document)}
        onEndpointChange={setSelectedEndpointId}
        onEndpointAdd={handleAddEndpoint}
        onEndpointDelete={handleDeleteEndpoint}
      />

      {activeId && activeDocument ? (
        <DocumentViewer
          document={activeDocument}
          onRetry={() => void handleRetry()}
        />
      ) : (
        <UploadView
          health={health}
          uploading={uploading}
          error={error}
          onUpload={handleUpload}
        />
      )}
    </div>
  )
}

export default App
