import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { strFromU8, unzipSync, zipSync } from 'fflate'
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

interface MineruService {
  id: string
  name: string
  url: string
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = path.resolve(process.env.MINERU_STUDIO_DATA_DIR || path.join(projectRoot, 'data'))
const uploadRoot = path.join(dataRoot, '.uploads')
const distRoot = path.join(projectRoot, 'dist')
const mineruServicesConfigPath = path.join(projectRoot, 'config', 'mineru-services.json')
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

const importedFileLimit = 2000
const importedFileSizeLimit = 500 * 1024 * 1024
const importedTotalSizeLimit = 1024 * 1024 * 1024
const importedArchiveExtensions = new Set(['.zip'])

await fsp.mkdir(uploadRoot, { recursive: true })

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase()
    callback(null, supportedExtensions.has(extension))
  },
})

const importUpload = multer({
  dest: uploadRoot,
  limits: { fileSize: importedFileSizeLimit, files: importedFileLimit },
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

function openFolderCommand() {
  if (process.platform === 'darwin') return 'open'
  if (process.platform === 'win32') return 'explorer'
  return 'xdg-open'
}

function openFolder(directory: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(openFolderCommand(), [directory], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
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

function parseMineruServices(value: unknown): MineruService[] {
  if (!value || typeof value !== 'object') throw new Error('MinerU 服务配置格式错误')
  const services = (value as { services?: unknown }).services
  if (!Array.isArray(services)) throw new Error('MinerU 服务配置缺少 services 数组')

  const ids = new Set<string>()
  const urls = new Set<string>()
  return services.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('MinerU 服务配置项格式错误')
    const service = value as Partial<MineruService>
    if (typeof service.id !== 'string' || !service.id.trim()) throw new Error('MinerU 服务编号不能为空')
    if (typeof service.name !== 'string' || !service.name.trim()) throw new Error('MinerU 服务名称不能为空')
    if (typeof service.url !== 'string') throw new Error('MinerU 服务地址不能为空')

    const url = normalizeMineruApiUrl(service.url)
    if (ids.has(service.id)) throw new Error(`MinerU 服务编号重复：${service.id}`)
    if (urls.has(url)) throw new Error(`MinerU 服务地址重复：${url}`)
    ids.add(service.id)
    urls.add(url)
    return { id: service.id, name: service.name.trim(), url }
  })
}

async function readMineruServices() {
  const content = await fsp.readFile(mineruServicesConfigPath, 'utf8')
  return parseMineruServices(JSON.parse(content) as unknown)
}

async function saveMineruServices(services: MineruService[]) {
  await writeJsonAtomic(mineruServicesConfigPath, { services })
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
  const backend = ['pipeline', 'vlm-engine', 'hybrid-engine'].includes(String(body.backend))
    ? String(body.backend)
    : 'hybrid-engine'
  const effort = body.effort === 'medium' ? 'medium' : 'high'
  const parseMethod = ['auto', 'txt', 'ocr'].includes(String(body.parseMethod))
    ? (String(body.parseMethod) as ParseOptions['parseMethod'])
    : 'ocr'
  return {
    mineruApiUrl: normalizeMineruApiUrl(body.mineruApiUrl),
    backend,
    effort,
    parseMethod,
    language: String(body.language || 'ch'),
    formulaEnable: normalizeBoolean(body.formulaEnable, true),
    tableEnable: normalizeBoolean(body.tableEnable, true),
    imageAnalysis: backend !== 'pipeline'
      && (backend === 'vlm-engine' || effort === 'high')
      && normalizeBoolean(body.imageAnalysis, true),
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

interface ImportedResult {
  sourceFilename: string
  sourceBytes: Uint8Array
  result: unknown
}

interface ImportedArchive {
  archiveFiles: Record<string, Uint8Array>
  resultZipBytes: Uint8Array
}

function normalizeArchivePath(filename: string) {
  return decodeUploadFilename(filename).replaceAll('\\', '/').replace(/^\.\//, '')
}

function basenameWithoutResultSuffix(filename: string) {
  const basename = path.posix.basename(filename)
  if (basename.toLowerCase() === 'content_list_v2.json') return ''
  return basename.replace(/_content_list_v2\.json$/i, '')
}

function isContentListV2Filename(filename: string) {
  const basename = path.posix.basename(filename).toLowerCase()
  return basename === 'content_list_v2.json' || basename.endsWith('_content_list_v2.json')
}

function findContentListEntry(entries: [string, Uint8Array][]) {
  const v2Entries = entries.filter(([filename]) => isContentListV2Filename(filename))
  if (v2Entries.length === 0) {
    throw new Error('导入结果缺少 content_list_v2.json 或 *_content_list_v2.json')
  }
  if (v2Entries.length > 1) {
    throw new Error('导入结果包含多个 content_list_v2，当前仅支持一次导入一个文档')
  }
  return v2Entries[0]
}

function selectImportedPdf(entries: [string, Uint8Array][], v2Filename: string) {
  const pdfEntries = entries.filter(([filename]) => filename.toLowerCase().endsWith('.pdf'))
  if (pdfEntries.length === 0) throw new Error('导入结果缺少原始 PDF 文件')
  if (pdfEntries.length === 1) return pdfEntries[0]

  const resultName = basenameWithoutResultSuffix(v2Filename).toLowerCase()
  const matchedEntries = pdfEntries.filter(([filename]) => path.posix.parse(filename).name.toLowerCase() === resultName)
  if (matchedEntries.length === 1) return matchedEntries[0]
  throw new Error('导入结果包含多个 PDF，无法确定与 OCR 结果对应的文件')
}

function buildImportedResult(files: Record<string, Uint8Array>, backend = 'imported'): ImportedResult {
  const entries = Object.entries(files)
    .map(([filename, content]) => [normalizeArchivePath(filename), content] as [string, Uint8Array])
    .filter(([filename]) => filename && !filename.endsWith('/'))
  const v2Entry = findContentListEntry(entries)
  const pdfEntry = selectImportedPdf(entries, v2Entry[0])
  const resultDirectory = path.posix.dirname(v2Entry[0])
  const resultName = path.posix.parse(pdfEntry[0]).name
  const relatedEntries = entries.filter(([filename]) => path.posix.dirname(filename) === resultDirectory)
  const markdownEntry = relatedEntries.find(([filename]) => filename.toLowerCase().endsWith('.md'))
  const middleJsonEntry = relatedEntries.find(([filename]) => filename.toLowerCase().endsWith('_middle.json'))
  const modelOutputEntry = relatedEntries.find(([filename]) => filename.toLowerCase().endsWith('_model.json'))
  const imageDirectory = resultDirectory === '.' ? 'images/' : `${resultDirectory}/images/`
  const images = Object.fromEntries(
    entries
      .filter(([filename]) => filename.startsWith(imageDirectory) && imageMimeType(filename).startsWith('image/'))
      .map(([filename, content]) => [
        path.posix.basename(filename),
        `data:${imageMimeType(filename)};base64,${Buffer.from(content).toString('base64')}`,
      ]),
  )

  return {
    sourceFilename: path.posix.basename(pdfEntry[0]),
    sourceBytes: pdfEntry[1],
    result: {
      backend,
      results: {
        [resultName]: {
          content_list_v2: strFromU8(v2Entry[1]),
          md_content: markdownEntry ? strFromU8(markdownEntry[1]) : '',
          ...(middleJsonEntry ? { middle_json: strFromU8(middleJsonEntry[1]) } : {}),
          ...(modelOutputEntry ? { model_output: strFromU8(modelOutputEntry[1]) } : {}),
          images,
        },
      },
    },
  }
}

async function saveImportedArchive({ archiveFiles, resultZipBytes }: ImportedArchive) {
  const imported = buildImportedResult(archiveFiles)
  const id = crypto.randomUUID()
  const directory = documentDirectory(id)
  const now = new Date().toISOString()
  const sourceFilename = 'source.pdf'
  const meta: DocumentMeta = {
    id,
    name: imported.sourceFilename,
    size: imported.sourceBytes.byteLength,
    mimeType: 'application/pdf',
    sourceFilename,
    createdAt: now,
    updatedAt: now,
    status: 'completed',
    options: parseOptions({}),
    pageCount: inferPageCount(imported.result),
  }

  try {
    await fsp.mkdir(directory, { recursive: true })
    await writeBytesAtomic(path.join(directory, sourceFilename), imported.sourceBytes)
    await writeBytesAtomic(resultZipPath(id), resultZipBytes)
    await writeJsonAtomic(resultPath(id), imported.result)
    await saveDocumentMeta(meta)
    return meta
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function buildUploadedImportArchive(
  uploadedFiles: Express.Multer.File[],
  rawPaths: unknown,
): Promise<ImportedArchive> {
  const archiveFile = uploadedFiles.length === 1
    && importedArchiveExtensions.has(path.extname(uploadedFiles[0].originalname).toLowerCase())
    ? uploadedFiles[0]
    : null

  if (archiveFile) {
    const resultZipBytes = new Uint8Array(await fsp.readFile(archiveFile.path))
    return { archiveFiles: unzipSync(resultZipBytes), resultZipBytes }
  }

  const relativePaths = typeof rawPaths === 'string' ? JSON.parse(rawPaths) as unknown : null
  if (!Array.isArray(relativePaths) || relativePaths.length !== uploadedFiles.length) {
    throw new Error('结果目录的文件路径信息不完整')
  }
  const archiveFiles = Object.fromEntries(await Promise.all(uploadedFiles.map(async (file, index) => {
    const relativePath = normalizeArchivePath(String(relativePaths[index] || file.originalname))
    return [relativePath, new Uint8Array(await fsp.readFile(file.path))]
  })))
  return { archiveFiles, resultZipBytes: zipSync(archiveFiles) }
}

function normalizeLocalImportPath(value: string) {
  const trimmed = value.trim()
  const hasMatchingQuotes = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  return hasMatchingQuotes ? trimmed.slice(1, -1).trim() : trimmed
}

async function buildLocalImportArchive(value: string): Promise<ImportedArchive> {
  const requestedPath = normalizeLocalImportPath(value)
  if (!requestedPath) throw new Error('请输入结果目录或 ZIP 的本机路径')
  if (!path.isAbsolute(requestedPath)) throw new Error('请输入以 / 开头的绝对路径')

  let resolvedPath: string
  try {
    resolvedPath = await fsp.realpath(requestedPath)
  } catch {
    throw new Error(`路径不存在或无法访问：${requestedPath}`)
  }
  const stats = await fsp.stat(resolvedPath)

  if (stats.isFile()) {
    if (!importedArchiveExtensions.has(path.extname(resolvedPath).toLowerCase())) {
      throw new Error('文件路径仅支持 ZIP，导入普通结果请填写目录路径')
    }
    if (stats.size > importedFileSizeLimit) throw new Error('ZIP 文件不能超过 500 MB')
    const resultZipBytes = new Uint8Array(await fsp.readFile(resolvedPath))
    return { archiveFiles: unzipSync(resultZipBytes), resultZipBytes }
  }
  if (!stats.isDirectory()) throw new Error('路径必须指向结果目录或 ZIP 文件')

  const archiveFiles: Record<string, Uint8Array> = {}
  let fileCount = 0
  let totalSize = 0

  async function collectFiles(directory: string) {
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await collectFiles(entryPath)
        continue
      }
      if (!entry.isFile()) continue

      fileCount += 1
      if (fileCount > importedFileLimit) throw new Error(`结果目录文件数不能超过 ${importedFileLimit}`)
      const entryStats = await fsp.stat(entryPath)
      if (entryStats.size > importedFileSizeLimit) throw new Error(`文件不能超过 500 MB：${entry.name}`)
      totalSize += entryStats.size
      if (totalSize > importedTotalSizeLimit) throw new Error('结果目录文件总量不能超过 1 GB')
      const relativePath = path.relative(resolvedPath, entryPath).split(path.sep).join('/')
      archiveFiles[relativePath] = new Uint8Array(await fsp.readFile(entryPath))
    }
  }

  await collectFiles(resolvedPath)
  if (fileCount === 0) throw new Error('结果目录中没有文件')
  return { archiveFiles, resultZipBytes: zipSync(archiveFiles) }
}

function buildResultFromZip(bytes: Uint8Array, meta: DocumentMeta) {
  const files = unzipSync(bytes)
  const entries = Object.entries(files)
  const v2Entry = findContentListEntry(entries)

  const markdownEntry = entries.find(([filename]) => filename.toLowerCase().endsWith('.md'))
  const middleJsonEntry = entries.find(([filename]) => filename.toLowerCase().endsWith('_middle.json'))
  const modelOutputEntry = entries.find(([filename]) => filename.toLowerCase().endsWith('_model.json'))
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
  if (meta.options.backend === 'hybrid-engine') form.append('effort', meta.options.effort)
  if (meta.options.backend !== 'vlm-engine') form.append('parse_method', meta.options.parseMethod)
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

app.get('/api/mineru-services', async (_request, response, next) => {
  try {
    response.json(await readMineruServices())
  } catch (error) {
    next(error)
  }
})

app.put('/api/mineru-services', async (request, response, next) => {
  try {
    const services = parseMineruServices({ services: request.body })
    await saveMineruServices(services)
    response.json(services)
  } catch (error) {
    next(error)
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

app.post('/api/imports', importUpload.array('files', importedFileLimit), async (request, response, next) => {
  const uploadedFiles = request.files as Express.Multer.File[] | undefined
  if (!uploadedFiles?.length) {
    response.status(400).json({ error: '请选择 MinerU 结果 ZIP 或结果目录' })
    return
  }

  try {
    const archive = await buildUploadedImportArchive(uploadedFiles, request.body.paths)
    const meta = await saveImportedArchive(archive)
    response.status(201).json(meta)
  } catch (error) {
    next(error)
  } finally {
    await Promise.all(uploadedFiles.map((file) => fsp.rm(file.path, { force: true })))
  }
})

app.post('/api/imports/path', async (request, response, next) => {
  const localPath = typeof request.body.path === 'string' ? request.body.path : ''
  if (!localPath.trim()) {
    response.status(400).json({ error: '请输入结果目录或 ZIP 的本机路径' })
    return
  }

  try {
    const archive = await buildLocalImportArchive(localPath)
    const meta = await saveImportedArchive(archive)
    response.status(201).json(meta)
  } catch (error) {
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

app.post('/api/documents/:id/open-folder', async (request, response, next) => {
  try {
    if (!isSafeId(request.params.id)) throw new Error('无效文档编号')
    const directory = documentDirectory(request.params.id)
    const stats = await fsp.stat(directory)
    if (!stats.isDirectory()) throw new Error('文档所在目录不存在')
    await openFolder(directory)
    response.status(204).end()
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

app.delete('/api/documents', async (request, response, next) => {
  try {
    const ids = request.body?.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 2000 || !ids.every((id) => typeof id === 'string' && isSafeId(id))) {
      throw new Error('无效文档编号列表')
    }

    await Promise.all(ids.map(async (id: string) => {
      const timer = pollingTimers.get(id)
      if (timer) clearTimeout(timer)
      pollingTimers.delete(id)
      await fsp.rm(documentDirectory(id), { recursive: true, force: true })
    }))
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
