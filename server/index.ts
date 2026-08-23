import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { strFromU8, unzipSync } from 'fflate'
import multer from 'multer'

type DocumentStatus =
  | 'submitting'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'

interface ParseOptions {
  mineruApiUrl: string
  backend: string
  effort: 'medium' | 'high'
  parseMethod: 'auto' | 'txt' | 'ocr'
  language: string
  formulaEnable: boolean
  tableEnable: boolean
  imageAnalysis: boolean
  outputZip: boolean
  outputMarkdown: boolean
  outputContentList: boolean
  outputImages: boolean
  outputMiddleJson: boolean
  outputModelOutput: boolean
  outputOriginalFile: boolean
}

interface DocumentMeta {
  id: string
  name: string
  size: number
  mimeType: string
  sourceFilename: string
  createdAt: string
  updatedAt: string
  status: DocumentStatus
  options: ParseOptions
  mineruTaskId?: string
  error?: string
  pageCount?: number
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = path.resolve(process.env.MINERU_STUDIO_DATA_DIR || path.join(projectRoot, 'data'))
const uploadRoot = path.join(dataRoot, '.uploads')
const distRoot = path.join(projectRoot, 'dist')
const defaultMineruApiUrl = (process.env.MINERU_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const port = Number(process.env.PORT || 8787)
const pollingTimers = new Map<string, NodeJS.Timeout>()

const supportedExtensions = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
  '.bmp',
  '.docx',
  '.pptx',
  '.xlsx',
])

await fsp.mkdir(uploadRoot, { recursive: true })

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase()
    callback(null, supportedExtensions.has(extension))
  },
})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

function documentDirectory(id: string) {
  return path.join(dataRoot, id)
}

function metadataPath(id: string) {
  return path.join(documentDirectory(id), 'metadata.json')
}

function resultPath(id: string) {
  return path.join(documentDirectory(id), 'result.json')
}

function resultZipPath(id: string) {
  return path.join(documentDirectory(id), 'result.zip')
}

function isSafeId(id: string) {
  return /^[a-f0-9-]{36}$/.test(id)
}

function decodeUploadFilename(filename: string) {
  const decoded = Buffer.from(filename, 'latin1').toString('utf8')
  return decoded.includes('\uFFFD') ? filename : decoded
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(temporaryPath, filePath)
}

async function writeBytesAtomic(filePath: string, value: Uint8Array) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(temporaryPath, value)
  await fsp.rename(temporaryPath, filePath)
}

async function readDocumentMeta(id: string): Promise<DocumentMeta> {
  const meta = JSON.parse(await fsp.readFile(metadataPath(id), 'utf8')) as DocumentMeta
  meta.options = parseOptions(meta.options as unknown as Record<string, unknown>)
  return meta
}

async function saveDocumentMeta(meta: DocumentMeta) {
  meta.updatedAt = new Date().toISOString()
  await writeJsonAtomic(metadataPath(meta.id), meta)
}

async function listDocumentMeta() {
  const entries = await fsp.readdir(dataRoot, { withFileTypes: true })
  const documents = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
      .map(async (entry) => {
        try {
          return await readDocumentMeta(entry.name)
        } catch {
          return null
        }
      }),
  )

  return documents
    .filter((document): document is DocumentMeta => document !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function normalizeMineruApiUrl(value: unknown) {
  const rawValue = String(value || defaultMineruApiUrl).trim()
  const parsed = new URL(/^https?:\/\//i.test(rawValue) ? rawValue : `http://${rawValue}`)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MinerU 地址仅支持 HTTP 或 HTTPS')
  if (parsed.username || parsed.password) throw new Error('MinerU 地址不能包含账号或密码')
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('MinerU 地址不能包含路径或参数')
  return parsed.origin
}

function parseOptions(body: Record<string, unknown>): ParseOptions {
  const effort = body.effort === 'medium' ? 'medium' : 'high'
  const parseMethod = ['auto', 'txt', 'ocr'].includes(String(body.parseMethod))
    ? (String(body.parseMethod) as ParseOptions['parseMethod'])
    : 'ocr'
  return {
    mineruApiUrl: normalizeMineruApiUrl(body.mineruApiUrl),
    backend: ['pipeline', 'vlm-engine', 'hybrid-engine'].includes(String(body.backend))
      ? String(body.backend)
      : 'hybrid-engine',
    effort,
    parseMethod,
    language: String(body.language || 'ch'),
    formulaEnable: normalizeBoolean(body.formulaEnable, true),
    tableEnable: normalizeBoolean(body.tableEnable, true),
    imageAnalysis: effort === 'high' && normalizeBoolean(body.imageAnalysis, true),
    outputZip: true,
    outputMarkdown: normalizeBoolean(body.outputMarkdown, true),
    outputContentList: true,
    outputImages: normalizeBoolean(body.outputImages, true),
    outputMiddleJson: normalizeBoolean(body.outputMiddleJson, false),
    outputModelOutput: normalizeBoolean(body.outputModelOutput, false),
    outputOriginalFile: normalizeBoolean(body.outputOriginalFile, false),
  }
}

function firstResult(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null
  const results = (payload as { results?: Record<string, unknown> }).results
  if (!results || typeof results !== 'object') return null
  return Object.values(results)[0] as Record<string, unknown> | undefined
}

function inferPageCount(payload: unknown) {
  const result = firstResult(payload)
  if (!result || typeof result.content_list_v2 !== 'string') return undefined
  try {
    const pages = JSON.parse(result.content_list_v2) as unknown
    return Array.isArray(pages) ? pages.length : undefined
  } catch {
    return undefined
  }
}

function imageMimeType(filename: string) {
  const extension = path.extname(filename).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (['.jpg', '.jpeg'].includes(extension)) return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.svg') return 'image/svg+xml'
  if (['.tif', '.tiff'].includes(extension)) return 'image/tiff'
  return 'application/octet-stream'
}

function buildResultFromZip(bytes: Uint8Array, meta: DocumentMeta) {
  const files = unzipSync(bytes)
  const entries = Object.entries(files)
  const v2Entry = entries.find(([filename]) => filename.endsWith('_content_list_v2.json'))
  if (!v2Entry) throw new Error('MinerU ZIP 结果缺少 content_list_v2.json')

  const markdownEntry = entries.find(([filename]) => filename.endsWith('.md'))
  const middleJsonEntry = entries.find(([filename]) => filename.endsWith('_middle.json'))
  const modelOutputEntry = entries.find(([filename]) => filename.endsWith('_model.json'))
  const images = Object.fromEntries(
    entries
      .filter(([filename]) => filename.includes('/images/') && imageMimeType(filename).startsWith('image/'))
      .map(([filename, content]) => [
        path.basename(filename),
        `data:${imageMimeType(filename)};base64,${Buffer.from(content).toString('base64')}`,
      ]),
  )
  const resultName = path.parse(meta.name).name

  return {
    backend: meta.options.backend,
    results: {
      [resultName]: {
        content_list_v2: strFromU8(v2Entry[1]),
        md_content: markdownEntry ? strFromU8(markdownEntry[1]) : '',
        ...(middleJsonEntry ? { middle_json: strFromU8(middleJsonEntry[1]) } : {}),
        ...(modelOutputEntry ? { model_output: strFromU8(modelOutputEntry[1]) } : {}),
        images,
      },
    },
  }
}

async function mineruFetch(baseUrl: string, endpoint: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${endpoint}`, init)
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`MinerU API ${response.status}: ${detail.slice(0, 500)}`)
  }
  return response
}

async function submitDocument(meta: DocumentMeta) {
  const sourcePath = path.join(documentDirectory(meta.id), meta.sourceFilename)
  const bytes = await fsp.readFile(sourcePath)
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(bytes)], { type: meta.mimeType }), meta.name)
  if (meta.options.backend === 'pipeline') form.append('lang_list', meta.options.language)
  form.append('backend', meta.options.backend)
  form.append('effort', meta.options.effort)
  form.append('parse_method', meta.options.parseMethod)
  form.append('formula_enable', String(meta.options.formulaEnable))
  form.append('table_enable', String(meta.options.tableEnable))
  form.append('image_analysis', String(meta.options.imageAnalysis))
  form.append('return_md', String(meta.options.outputMarkdown))
  form.append('return_middle_json', String(meta.options.outputMiddleJson))
  form.append('return_model_output', String(meta.options.outputModelOutput))
  form.append('return_content_list', String(meta.options.outputContentList))
  form.append('return_images', String(meta.options.outputImages))
  form.append('response_format_zip', String(meta.options.outputZip))
  form.append('return_original_file', String(meta.options.outputOriginalFile))
  form.append('start_page_id', '0')
  form.append('end_page_id', '99999')

  const response = await mineruFetch(meta.options.mineruApiUrl, '/tasks', { method: 'POST', body: form })
  const payload = (await response.json()) as { task_id?: string; status?: string }
  if (!payload.task_id) throw new Error('MinerU API 未返回 task_id')

  meta.mineruTaskId = payload.task_id
  meta.status = payload.status === 'processing' ? 'processing' : 'pending'
  meta.error = undefined
  await saveDocumentMeta(meta)
  schedulePoll(meta.id, 500)
}

function schedulePoll(id: string, delay = 1200) {
  if (pollingTimers.has(id)) return
  const timer = setTimeout(() => {
    pollingTimers.delete(id)
    void pollDocument(id)
  }, delay)
  pollingTimers.set(id, timer)
}

async function pollDocument(id: string) {
  let meta: DocumentMeta
  try {
    meta = await readDocumentMeta(id)
  } catch {
    return
  }
  if (!meta.mineruTaskId || ['completed', 'failed'].includes(meta.status)) return

  try {
    const statusResponse = await mineruFetch(meta.options.mineruApiUrl, `/tasks/${meta.mineruTaskId}`)
    const statusPayload = (await statusResponse.json()) as { status?: string; error?: string }
    if (statusPayload.status === 'failed') {
      meta.status = 'failed'
      meta.error = statusPayload.error || 'MinerU 解析失败'
      await saveDocumentMeta(meta)
      return
    }

    if (statusPayload.status !== 'completed') {
      meta.status = statusPayload.status === 'processing' ? 'processing' : 'pending'
      await saveDocumentMeta(meta)
      schedulePoll(id)
      return
    }

    const resultResponse = await mineruFetch(meta.options.mineruApiUrl, `/tasks/${meta.mineruTaskId}/result`)
    const contentType = resultResponse.headers.get('content-type') || ''
    if (!contentType.includes('application/zip')) {
      throw new Error(`MinerU 任务结果不是 ZIP：${contentType || '未知类型'}`)
    }
    const zipBytes = new Uint8Array(await resultResponse.arrayBuffer())
    const result = buildResultFromZip(zipBytes, meta)
    await writeBytesAtomic(resultZipPath(id), zipBytes)
    await writeJsonAtomic(resultPath(id), result)
    meta.status = 'completed'
    meta.pageCount = inferPageCount(result)
    meta.options = parseOptions(meta.options as unknown as Record<string, unknown>)
    meta.error = undefined
    await saveDocumentMeta(meta)
  } catch (error) {
    meta.error = error instanceof Error ? error.message : '无法查询 MinerU 任务'
    await saveDocumentMeta(meta)
    schedulePoll(id, 3000)
  }
}

app.get('/api/health', async (request, response) => {
  let targetUrl = defaultMineruApiUrl
  try {
    targetUrl = normalizeMineruApiUrl(request.query.mineruApiUrl)
    const healthResponse = await mineruFetch(targetUrl, '/health')
    const payload = await healthResponse.json()
    response.json({ available: true, url: targetUrl, ...payload })
  } catch (error) {
    response.json({
      available: false,
      url: targetUrl,
      error: error instanceof Error ? error.message : 'MinerU API 不可用',
    })
  }
})

app.get('/api/documents', async (_request, response, next) => {
  try {
    const documents = await listDocumentMeta()
    for (const document of documents) {
      if (['pending', 'processing', 'submitting'].includes(document.status)) {
        schedulePoll(document.id, 100)
      }
    }
    response.json(documents)
  } catch (error) {
    next(error)
  }
})

app.post('/api/documents', upload.single('file'), async (request, response, next) => {
  if (!request.file) {
    response.status(400).json({ error: '请选择支持的文档文件' })
    return
  }

  const id = crypto.randomUUID()
  const directory = documentDirectory(id)
  const originalName = decodeUploadFilename(request.file.originalname)
  const extension = path.extname(originalName).toLowerCase()
  const sourceFilename = `source${extension}`
  const now = new Date().toISOString()
  const meta: DocumentMeta = {
    id,
    name: originalName,
    size: request.file.size,
    mimeType: request.file.mimetype || 'application/octet-stream',
    sourceFilename,
    createdAt: now,
    updatedAt: now,
    status: 'submitting',
    options: parseOptions(request.body as Record<string, unknown>),
  }

  try {
    await fsp.mkdir(directory, { recursive: true })
    await fsp.rename(request.file.path, path.join(directory, sourceFilename))
    await saveDocumentMeta(meta)
    await submitDocument(meta)
    response.status(202).json(meta)
  } catch (error) {
    meta.status = 'failed'
    meta.error = error instanceof Error ? error.message : '任务提交失败'
    await saveDocumentMeta(meta).catch(() => undefined)
    next(error)
  }
})

app.post('/api/documents/:id/retry', async (request, response, next) => {
  try {
    if (!isSafeId(request.params.id)) throw new Error('无效文档编号')
    const meta = await readDocumentMeta(request.params.id)
    meta.status = 'submitting'
    meta.error = undefined
    meta.mineruTaskId = undefined
    meta.options = parseOptions(request.body as Record<string, unknown>)
    await saveDocumentMeta(meta)
    await submitDocument(meta)
    response.status(202).json(meta)
  } catch (error) {
    next(error)
  }
})

app.get('/api/documents/:id', async (request, response, next) => {
  try {
    if (!isSafeId(request.params.id)) throw new Error('无效文档编号')
    const meta = await readDocumentMeta(request.params.id)
    let result: unknown = null
    if (meta.status === 'completed') {
      result = JSON.parse(await fsp.readFile(resultPath(meta.id), 'utf8'))
    }
    response.json({ ...meta, result })
  } catch (error) {
    next(error)
  }
})

app.get('/api/documents/:id/source', async (request, response, next) => {
  try {
    if (!isSafeId(request.params.id)) throw new Error('无效文档编号')
    const meta = await readDocumentMeta(request.params.id)
    response.type(meta.mimeType)
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`)
    response.sendFile(path.join(documentDirectory(meta.id), meta.sourceFilename))
  } catch (error) {
    next(error)
  }
})

app.get('/api/documents/:id/download/:format', async (request, response, next) => {
  try {
    if (!isSafeId(request.params.id)) throw new Error('无效文档编号')
    const meta = await readDocumentMeta(request.params.id)
    const payload = JSON.parse(await fsp.readFile(resultPath(meta.id), 'utf8')) as unknown
    const result = firstResult(payload)
    const baseName = path.parse(meta.name).name

    if (request.params.format === 'zip') {
      if (!fs.existsSync(resultZipPath(meta.id))) {
        response.status(404).json({ error: '当前记录没有可下载的 ZIP 结果' })
        return
      }
      response.type('application/zip')
      response.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}_MinerU.zip`)}`,
      )
      response.sendFile(resultZipPath(meta.id))
      return
    }

    if (request.params.format === 'markdown' && typeof result?.md_content === 'string') {
      response.type('text/markdown; charset=utf-8')
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.md`)}`)
      response.send(result.md_content)
      return
    }

    if (request.params.format === 'json' && typeof result?.content_list_v2 === 'string') {
      response.type('application/json; charset=utf-8')
      response.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}_content_list_v2.json`)}`,
      )
      response.send(result.content_list_v2)
      return
    }

    response.status(404).json({ error: '未找到指定格式的解析结果' })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/documents/:id', async (request, response, next) => {
  try {
    if (!isSafeId(request.params.id)) throw new Error('无效文档编号')
    const timer = pollingTimers.get(request.params.id)
    if (timer) clearTimeout(timer)
    pollingTimers.delete(request.params.id)
    await fsp.rm(documentDirectory(request.params.id), { recursive: true, force: true })
    response.status(204).end()
  } catch (error) {
    next(error)
  }
})

if (fs.existsSync(distRoot)) {
  app.use(express.static(distRoot))
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/')) return next()
    response.sendFile(path.join(distRoot, 'index.html'))
  })
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : '服务器发生未知错误'
  console.error(`[MinerU Studio] ${message}`)
  response.status(500).json({ error: message })
})

app.listen(port, '127.0.0.1', async () => {
  console.log(`MinerU Studio 服务已启动：http://127.0.0.1:${port}`)
  const documents = await listDocumentMeta().catch(() => [])
  for (const document of documents) {
    if (['pending', 'processing', 'submitting'].includes(document.status)) schedulePoll(document.id, 200)
  }
})
