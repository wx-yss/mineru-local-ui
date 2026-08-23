import type { DocumentDetail, DocumentMeta, HealthState, ParseOptions } from './types'

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

export function deleteDocument(id: string) {
  return request<void>(`/api/documents/${id}`, { method: 'DELETE' })
}

export async function uploadDocument(file: File, options: ParseOptions) {
  const form = new FormData()
  form.append('file', file)
  Object.entries(options).forEach(([key, value]) => form.append(key, String(value)))
  return request<DocumentMeta>('/api/documents', { method: 'POST', body: form })
}

export function retryDocument(id: string, options: ParseOptions) {
  return request<DocumentMeta>(`/api/documents/${id}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
}
