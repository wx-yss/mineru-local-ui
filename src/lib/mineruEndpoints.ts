import type { MineruEndpoint } from '../types'

export const serverDefaultEndpoint: MineruEndpoint = {
  id: 'server-default',
  name: '服务器默认',
  url: '',
}

const endpointsStorageKey = 'mineru-studio:endpoints'
const selectedEndpointStorageKey = 'mineru-studio:selected-endpoint'

export function normalizeMineruEndpointUrl(host: string, port: string) {
  const rawHost = host.trim()
  if (!rawHost) throw new Error('请填写 IP 或域名')

  const parsed = new URL(/^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP 或 HTTPS')
  if (parsed.username || parsed.password) throw new Error('地址不能包含账号或密码')
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('地址只填写 IP 或域名，不要填写路径')

  const normalizedPort = port.trim()
  if (normalizedPort) {
    const numericPort = Number(normalizedPort)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new Error('端口必须是 1–65535 的整数')
    }
    parsed.port = normalizedPort
  }

  return parsed.origin
}

export function createMineruEndpoint(name: string, host: string, port: string): MineruEndpoint {
  const url = normalizeMineruEndpointUrl(host, port)
  return {
    id: crypto.randomUUID(),
    name: name.trim() || new URL(url).host,
    url,
  }
}

export function loadMineruEndpoints(): MineruEndpoint[] {
  try {
    const saved = JSON.parse(localStorage.getItem(endpointsStorageKey) || '[]') as unknown
    if (!Array.isArray(saved)) return []
    return saved.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const endpoint = value as Partial<MineruEndpoint>
      if (typeof endpoint.id !== 'string' || typeof endpoint.name !== 'string' || typeof endpoint.url !== 'string') {
        return []
      }
      try {
        const parsed = new URL(endpoint.url)
        return [{ id: endpoint.id, name: endpoint.name, url: parsed.origin }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function saveMineruEndpoints(endpoints: MineruEndpoint[]) {
  localStorage.setItem(endpointsStorageKey, JSON.stringify(endpoints))
}

export function loadSelectedEndpointId() {
  return localStorage.getItem(selectedEndpointStorageKey) || serverDefaultEndpoint.id
}

export function saveSelectedEndpointId(id: string) {
  localStorage.setItem(selectedEndpointStorageKey, id)
}
