import { Check, FileImage, FileText, FolderOpen, ListChecks, Plus, Server, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import { formatFileSize } from '../lib/mineru'
import { createMineruEndpoint, serverDefaultEndpoint } from '../lib/mineruEndpoints'
import type { DocumentMeta, HealthState, MineruEndpoint } from '../types'
import { StatusBadge } from './StatusBadge'

interface SidebarProps {
  documents: DocumentMeta[]
  activeId: string | null
  health: HealthState | null
  endpoints: MineruEndpoint[]
  selectedEndpointId: string
  serverDefaultUrl: string
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (document: DocumentMeta) => void
  onOpenFolder: (document: DocumentMeta) => void
  onDeleteMany: (documents: DocumentMeta[]) => Promise<boolean>
  onEndpointChange: (id: string) => void
  onEndpointAdd: (endpoint: MineruEndpoint) => void
  onEndpointDelete: (id: string) => void
}

export function Sidebar({
  documents,
  activeId,
  health,
  endpoints,
  selectedEndpointId,
  serverDefaultUrl,
  onNew,
  onSelect,
  onDelete,
  onOpenFolder,
  onDeleteMany,
  onEndpointChange,
  onEndpointAdd,
  onEndpointDelete,
}: SidebarProps) {
  const [endpointEditorOpen, setEndpointEditorOpen] = useState(false)
  const [endpointName, setEndpointName] = useState('')
  const [endpointHost, setEndpointHost] = useState('')
  const [endpointPort, setEndpointPort] = useState('8000')
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const selectedEndpoint = endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? serverDefaultEndpoint
  const allSelected = documents.length > 0 && selectedIds.size === documents.length

  function toggleSelectionMode() {
    if (deleting) return
    setSelectionMode((current) => !current)
    setSelectedIds(new Set())
  }

  function toggleDocumentSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(documents.map((document) => document.id)))
  }

  async function deleteSelected() {
    const selectedDocuments = documents.filter((document) => selectedIds.has(document.id))
    if (selectedDocuments.length === 0 || deleting) return
    setDeleting(true)
    try {
      const deleted = await onDeleteMany(selectedDocuments)
      if (!deleted) return
      setSelectedIds(new Set())
      setSelectionMode(false)
    } finally {
      setDeleting(false)
    }
  }

  function addEndpoint() {
    try {
      const endpoint = createMineruEndpoint(endpointName, endpointHost, endpointPort)
      onEndpointAdd(endpoint)
      setEndpointName('')
      setEndpointHost('')
      setEndpointError(null)
    } catch (addError) {
      setEndpointError(addError instanceof Error ? addError.message : 'MinerU 地址无效')
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand" aria-label="本地解析台">
        <span className="brand-mark">M</span>
        <span>MinerU Studio</span>
      </div>

      <button className={`new-document-button ${activeId === null ? 'active' : ''}`} onClick={onNew}>
        <Plus size={18} />
        新解析
      </button>

      <div className="sidebar-section-title">
        <div className="sidebar-section-label">
          <span>已解析文件</span>
          <span>{documents.length}</span>
        </div>
        <button
          className={`selection-mode-button ${selectionMode ? 'active' : ''}`}
          type="button"
          aria-label={selectionMode ? '退出多选' : '多选文件'}
          title={selectionMode ? '退出多选' : '多选文件'}
          disabled={deleting}
          onClick={toggleSelectionMode}
        >
          {selectionMode ? <X size={15} /> : <ListChecks size={15} />}
        </button>
      </div>

      {selectionMode && (
        <div className="selection-toolbar">
          <span>已选 {selectedIds.size} 项</span>
          <button type="button" onClick={toggleSelectAll} disabled={documents.length === 0 || deleting}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <button
            className="selection-delete-button"
            type="button"
            disabled={selectedIds.size === 0 || deleting}
            onClick={deleteSelected}
          >
            <Trash2 size={13} />删除
          </button>
        </div>
      )}

      <nav className="document-list" aria-label="已解析文件">
        {documents.length === 0 ? (
          <div className="empty-history">
            <FileText size={22} />
            <span>上传后的文件会保存在这里</span>
          </div>
        ) : (
          documents.map((document) => {
            const Icon = document.mimeType.startsWith('image/') ? FileImage : FileText
            return (
              <button
                key={document.id}
                className={`document-item ${activeId === document.id ? 'active' : ''} ${selectedIds.has(document.id) ? 'selected' : ''}`}
                aria-pressed={selectionMode ? selectedIds.has(document.id) : activeId === document.id}
                onClick={() => selectionMode ? toggleDocumentSelection(document.id) : onSelect(document.id)}
              >
                {selectionMode && (
                  <span className="document-selection-indicator" aria-hidden="true">
                    {selectedIds.has(document.id) && <Check size={13} strokeWidth={3} />}
                  </span>
                )}
                <span className="document-icon">
                  <Icon size={18} />
                </span>
                <span className="document-summary">
                  <strong title={document.name}>{document.name}</strong>
                  <span>{formatFileSize(document.size)}</span>
                  {document.status !== 'completed' && <StatusBadge status={document.status} />}
                </span>
                {!selectionMode && (
                  <span className="document-actions">
                    <span
                      className="document-action delete-document"
                      role="button"
                      tabIndex={0}
                      title="删除记录"
                      aria-label="删除记录"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(document)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          event.stopPropagation()
                          onDelete(document)
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </span>
                    <span
                      className="document-action open-folder-document"
                      role="button"
                      tabIndex={0}
                      title="打开所在目录"
                      aria-label="打开所在目录"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenFolder(document)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          event.stopPropagation()
                          onOpenFolder(document)
                        }
                      }}
                    >
                      <FolderOpen size={15} />
                    </span>
                  </span>
                )}
              </button>
            )
          })
        )}
      </nav>

      <div className={`sidebar-service ${endpointEditorOpen ? 'expanded' : ''}`}>
        <div className="sidebar-service-summary">
          <div className="sidebar-health" title={health?.error || health?.url}>
            <span className={`health-dot ${health?.available ? 'online' : 'offline'}`} />
            <span>{health?.available ? `MinerU ${health.version || 'API'} 已连接` : 'MinerU API 未连接'}</span>
          </div>
          <button
            className={`endpoint-config-button ${endpointEditorOpen ? 'active' : ''}`}
            type="button"
            aria-label="配置 MinerU 服务"
            title="配置 MinerU 地址"
            onClick={() => setEndpointEditorOpen((current) => !current)}
          >
            <Server size={15} />
          </button>
        </div>

        <select
          className="sidebar-endpoint-select"
          aria-label="MinerU 服务"
          value={selectedEndpointId}
          onChange={(event) => onEndpointChange(event.target.value)}
        >
          {endpoints.map((endpoint) => (
            <option key={endpoint.id} value={endpoint.id}>
              {endpoint.name}
            </option>
          ))}
        </select>

        {endpointEditorOpen && (
          <div className="endpoint-editor sidebar-endpoint-editor">
            <div className="endpoint-current-url">
              当前：{selectedEndpoint.url || serverDefaultUrl}
            </div>
            <input
              aria-label="服务名称"
              value={endpointName}
              placeholder="名称，例如：公司"
              onChange={(event) => setEndpointName(event.target.value)}
            />
            <div className="endpoint-address-fields">
              <input
                aria-label="IP 或域名"
                value={endpointHost}
                placeholder="IP 或域名"
                onChange={(event) => setEndpointHost(event.target.value)}
              />
              <input
                aria-label="端口"
                value={endpointPort}
                inputMode="numeric"
                placeholder="端口"
                onChange={(event) => setEndpointPort(event.target.value)}
              />
            </div>
            <button className="endpoint-add-button" type="button" onClick={addEndpoint}>
              <Plus size={14} />添加服务
            </button>
            {endpointError && <div className="endpoint-error">{endpointError}</div>}

            {endpoints.some((endpoint) => endpoint.id !== serverDefaultEndpoint.id) && (
              <div className="endpoint-list">
                {endpoints.filter((endpoint) => endpoint.id !== serverDefaultEndpoint.id).map((endpoint) => (
                  <div key={endpoint.id} className="endpoint-list-item">
                    <button type="button" onClick={() => onEndpointChange(endpoint.id)}>
                      <strong>{endpoint.name}</strong>
                      <span>{endpoint.url}</span>
                    </button>
                    <button
                      className="endpoint-delete-button"
                      type="button"
                      title={`删除 ${endpoint.name}`}
                      onClick={() => onEndpointDelete(endpoint.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
