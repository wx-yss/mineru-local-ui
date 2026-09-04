import { useCallback, useEffect, useState } from 'react'

import './App.css'
import {
  deleteDocument,
  deleteDocuments,
  getDocument,
  getHealth,
  importResult,
  importResultPath,
  listMineruServices,
  listDocuments,
  openDocumentFolder,
  retryDocument,
  saveMineruServices,
  uploadDocument,
} from './api'
import { DocumentViewer } from './components/DocumentViewer'
import { Sidebar } from './components/Sidebar'
import { UploadView } from './components/UploadView'
import {
  clearLegacyMineruEndpoints,
  loadMineruEndpoints,
  loadSelectedEndpointId,
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
    let cancelled = false
    const legacyEndpoints = loadMineruEndpoints()
    void (async () => {
      try {
        const savedEndpoints = await listMineruServices()
        const mergedEndpoints = [
          ...savedEndpoints,
          ...legacyEndpoints.filter((legacy) => !savedEndpoints.some((saved) => saved.url === legacy.url)),
        ]
        const persistedEndpoints = mergedEndpoints.length === savedEndpoints.length
          ? savedEndpoints
          : await saveMineruServices(mergedEndpoints)
        if (cancelled) return
        setCustomEndpoints(persistedEndpoints)
        clearLegacyMineruEndpoints()
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '无法读取 MinerU 服务配置')
      }
    })()
    return () => {
      cancelled = true
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
      saveSelectedEndpointId(selectedEndpoint.id)
    } catch {
      // 浏览器禁用本地存储时仍允许当前页面使用服务地址。
    }
  }, [selectedEndpoint.id])

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

  async function handleImport(files: File[]) {
    setUploading(true)
    setError(null)
    try {
      const document = await importResult(files)
      await refreshDocuments()
      setActiveId(document.id)
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '结果导入失败')
    } finally {
      setUploading(false)
    }
  }

  async function handleImportPath(path: string) {
    setUploading(true)
    setError(null)
    try {
      const document = await importResultPath(path)
      await refreshDocuments()
      setActiveId(document.id)
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '路径导入失败')
    } finally {
      setUploading(false)
    }
  }

  async function handleAddEndpoint(endpoint: MineruEndpoint) {
    const nextEndpoints = [
      ...customEndpoints.filter((item) => item.url !== endpoint.url),
      endpoint,
    ]
    try {
      setError(null)
      setCustomEndpoints(await saveMineruServices(nextEndpoints))
      setSelectedEndpointId(endpoint.id)
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '保存 MinerU 服务失败'
      setError(message)
      throw saveError
    }
  }

  async function handleDeleteEndpoint(id: string) {
    const nextEndpoints = customEndpoints.filter((endpoint) => endpoint.id !== id)
    try {
      setError(null)
      setCustomEndpoints(await saveMineruServices(nextEndpoints))
      if (selectedEndpointId === id) setSelectedEndpointId(serverDefaultEndpoint.id)
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '删除 MinerU 服务失败'
      setError(message)
      throw saveError
    }
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

  async function handleOpenFolder(document: DocumentMeta) {
    setError(null)
    try {
      await openDocumentFolder(document.id)
    } catch (openFolderError) {
      setError(openFolderError instanceof Error ? openFolderError.message : '打开文件所在目录失败')
    }
  }

  async function handleDeleteMany(selectedDocuments: DocumentMeta[]) {
    const documentNames = selectedDocuments.length === 1
      ? `“${selectedDocuments[0].name}”`
      : `${selectedDocuments.length} 个文件`
    if (!window.confirm(`删除${documentNames}及其本地解析结果？`)) return false
    setError(null)
    try {
      await deleteDocuments(selectedDocuments.map((document) => document.id))
      if (activeId && selectedDocuments.some((document) => document.id === activeId)) {
        setActiveId(null)
        setActiveDocument(null)
      }
      await refreshDocuments()
      return true
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '批量删除失败')
      return false
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
        onOpenFolder={(document) => void handleOpenFolder(document)}
        onDeleteMany={handleDeleteMany}
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
          onImport={handleImport}
          onImportPath={handleImportPath}
        />
      )}
    </div>
  )
}

export default App
