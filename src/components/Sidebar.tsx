import { FileImage, FileText, Plus, Server, Trash2 } from 'lucide-react'
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
  onEndpointChange,
  onEndpointAdd,
  onEndpointDelete,
}: SidebarProps) {
  const [endpointEditorOpen, setEndpointEditorOpen] = useState(false)
  const [endpointName, setEndpointName] = useState('')
  const [endpointHost, setEndpointHost] = useState('')
  const [endpointPort, setEndpointPort] = useState('8000')
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const selectedEndpoint = endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? serverDefaultEndpoint

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
        <span>已解析文件</span>
        <span>{documents.length}</span>
      </div>

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
                className={`document-item ${activeId === document.id ? 'active' : ''}`}
                onClick={() => onSelect(document.id)}
              >
                <span className="document-icon">
                  <Icon size={18} />
                </span>
                <span className="document-summary">
                  <strong title={document.name}>{document.name}</strong>
                  <span>{formatFileSize(document.size)}</span>
                  {document.status !== 'completed' && <StatusBadge status={document.status} />}
                </span>
                <span
                  className="delete-document"
                  role="button"
                  tabIndex={0}
                  title="删除记录"
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
