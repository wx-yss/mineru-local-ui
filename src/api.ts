import type { DocumentDetail, DocumentMeta, HealthState, MineruEndpoint, ParseOptions } from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try {
      const payload = (await response.json()) as { error?: string }
      if (payload.error) message = payload.error
    } catch {
      // 非 JSON 错误响应使用默认文案。
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function listDocuments() {
  return request<DocumentMeta[]>('/api/documents')
}

export function getDocument(id: string) {
  return request<DocumentDetail>(`/api/documents/${id}`)
}

export function getHealth(mineruApiUrl = '') {
  const query = mineruApiUrl ? `?mineruApiUrl=${encodeURIComponent(mineruApiUrl)}` : ''
  return request<HealthState>(`/api/health${query}`)
}

export function listMineruServices() {
  return request<MineruEndpoint[]>('/api/mineru-services')
}

export function saveMineruServices(services: MineruEndpoint[]) {
  return request<MineruEndpoint[]>('/api/mineru-services', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(services),
  })
}

export function deleteDocument(id: string) {
  return request<void>(`/api/documents/${id}`, { method: 'DELETE' })
}

export function openDocumentFolder(id: string) {
  return request<void>(`/api/documents/${id}/open-folder`, { method: 'POST' })
}

export function deleteDocuments(ids: string[]) {
  return request<void>('/api/documents', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

export async function uploadDocument(file: File, options: ParseOptions) {
  const form = new FormData()
  form.append('file', file)
  Object.entries(options).forEach(([key, value]) => form.append(key, String(value)))
  return request<DocumentMeta>('/api/documents', { method: 'POST', body: form })
}

export async function importResult(files: File[]) {
  const form = new FormData()
  files.forEach((file) => form.append('files', file))
  form.append('paths', JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)))
  return request<DocumentMeta>('/api/imports', { method: 'POST', body: form })
}

export function importResultPath(path: string) {
  return request<DocumentMeta>('/api/imports/path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

export function retryDocument(id: string, options: ParseOptions) {
  return request<DocumentMeta>(`/api/documents/${id}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
}
