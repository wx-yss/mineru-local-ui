import { ChevronDown, ChevronRight, FileUp, LoaderCircle, Settings2, UploadCloud, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { formatFileSize } from '../lib/mineru'
import type { HealthState, ParseOptions } from '../types'

interface UploadViewProps {
  health: HealthState | null
  uploading: boolean
  error: string | null
  onUpload: (file: File, options: ParseOptions) => Promise<void>
}

const defaultOptions: ParseOptions = {
  mineruApiUrl: '',
  backend: 'hybrid-engine',
  effort: 'high',
  parseMethod: 'ocr',
  language: 'ch',
  formulaEnable: true,
  tableEnable: true,
  imageAnalysis: false,
  outputZip: true,
  outputMarkdown: true,
  outputContentList: true,
  outputImages: true,
  outputMiddleJson: false,
  outputModelOutput: false,
  outputOriginalFile: false,
}

const optionsStorageKey = 'mineru-studio:parse-options'

function loadRememberedOptions(): ParseOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(optionsStorageKey) || 'null') as Partial<ParseOptions> | null
    if (!saved || typeof saved !== 'object') return defaultOptions

    return {
      ...defaultOptions,
      ...saved,
      backend: ['pipeline', 'vlm-engine', 'hybrid-engine'].includes(String(saved.backend))
        ? String(saved.backend)
        : defaultOptions.backend,
      effort: saved.effort === 'medium' || saved.effort === 'high' ? saved.effort : defaultOptions.effort,
      parseMethod: ['auto', 'txt', 'ocr'].includes(String(saved.parseMethod))
        ? (saved.parseMethod as ParseOptions['parseMethod'])
        : defaultOptions.parseMethod,
      language: typeof saved.language === 'string' ? saved.language : defaultOptions.language,
      mineruApiUrl: '',
      outputZip: true,
      outputContentList: true,
    }
  } catch {
    return defaultOptions
  }
}

export function UploadView({
  health,
  uploading,
  error,
  onUpload,
}: UploadViewProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [commonOpen, setCommonOpen] = useState(true)
  const [otherOpen, setOtherOpen] = useState(false)
  const [options, setOptions] = useState<ParseOptions>(loadRememberedOptions)

  useEffect(() => {
    try {
      localStorage.setItem(optionsStorageKey, JSON.stringify(options))
    } catch {
      // 浏览器禁用本地存储时仍允许正常解析。
    }
  }, [options])

  function chooseFile(nextFile: File | undefined) {
    if (nextFile) setFile(nextFile)
  }

  async function submit() {
    if (!file || uploading) return
    await onUpload(file, options)
  }

  return (
    <main className="upload-view">
      <header className="upload-header">
        <div>
          <span className="eyebrow">LOCAL DOCUMENT PARSER</span>
          <h1>智能解析</h1>
          <p>将文档转换为可检索、可联动的结构化内容</p>
        </div>
        <div className={`api-connection ${health?.available ? 'online' : 'offline'}`}>
          <span className="health-dot" />
          {health?.available ? `MinerU ${health.version || '3.4.5'}` : 'API 离线'}
        </div>
      </header>

      <section className="upload-workspace">
        <div
          className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            chooseFile(event.dataTransfer.files[0])
          }}
        >
          <input
            ref={inputRef}
            type="file"
            hidden
            accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,.docx,.pptx,.xlsx"
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />

          {file ? (
            <div className="selected-file">
              <span className="selected-file-icon"><FileUp size={26} /></span>
              <div>
                <strong>{file.name}</strong>
                <span>{formatFileSize(file.size)}</span>
              </div>
              <button className="icon-button" title="移除文件" onClick={() => setFile(null)}>
                <X size={18} />
              </button>
            </div>
          ) : (
            <div className="dropzone-empty">
              <span className="upload-glyph"><UploadCloud size={34} /></span>
              <strong>拖入文档，或从电脑选择</strong>
              <span>PDF、图片、DOCX、PPTX、XLSX</span>
              <button className="secondary-button" onClick={() => inputRef.current?.click()}>
                <FileUp size={17} />
                选择文件
              </button>
            </div>
          )}

          {file && (
            <div className="upload-actions">
              <button className="secondary-button" onClick={() => inputRef.current?.click()} disabled={uploading}>
                更换文件
              </button>
              <button className="primary-button" onClick={() => void submit()} disabled={uploading || !health?.available}>
                {uploading ? <LoaderCircle size={17} className="spin" /> : <UploadCloud size={17} />}
                {uploading ? '正在提交' : '开始解析'}
              </button>
            </div>
          )}

          {error && <div className="inline-error">{error}</div>}
          {!health?.available && <div className="inline-warning">请先启动本地 MinerU API</div>}
        </div>

        <aside className="settings-panel">
          <div className="settings-title"><span><Settings2 size={17} />解析设置</span></div>

          <section className="settings-group">
            <button className="settings-group-heading" onClick={() => setCommonOpen((current) => !current)}>
              <span>常用设置</span>
              {commonOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {commonOpen && (
              <div className="settings-group-body">
                <label className="setting-row">
                  <span>解析后端</span>
                  <select
                    value={options.backend}
                    onChange={(event) => setOptions((current) => ({ ...current, backend: event.target.value }))}
                  >
                    <option value="hybrid-engine">Hybrid 本地</option>
                    <option value="vlm-engine">VLM 本地</option>
                    <option value="pipeline">Pipeline</option>
                  </select>
                </label>

                <div className="setting-row">
                  <span>解析强度</span>
                  <div className="segmented-control">
                    {(['medium', 'high'] as const).map((effort) => (
                      <button
                        key={effort}
                        className={options.effort === effort ? 'active' : ''}
                        onClick={() =>
                          setOptions((current) => ({
                            ...current,
                            effort,
                            imageAnalysis: effort === 'high' ? current.imageAnalysis : false,
                          }))
                        }
                      >
                        {effort === 'medium' ? 'Medium' : 'High'}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="setting-row">
                  <span>OCR 识别</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.parseMethod === 'ocr'}
                    onChange={(event) =>
                      setOptions((current) => ({ ...current, parseMethod: event.target.checked ? 'ocr' : 'auto' }))
                    }
                  />
                </label>
              </div>
            )}
          </section>

          <section className="settings-group">
            <button className="settings-group-heading" onClick={() => setOtherOpen((current) => !current)}>
              <span>其他设置</span>
              {otherOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {otherOpen && (
              <div className="settings-group-body">
                <label className="setting-row">
                  <span>公式识别</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.formulaEnable}
                    onChange={(event) => setOptions((current) => ({ ...current, formulaEnable: event.target.checked }))}
                  />
                </label>

                <label className="setting-row">
                  <span>表格识别</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.tableEnable}
                    onChange={(event) => setOptions((current) => ({ ...current, tableEnable: event.target.checked }))}
                  />
                </label>

                <label className={`setting-row ${options.effort !== 'high' ? 'disabled' : ''}`}>
                  <span>图像分析</span>
                  <input
                    className="switch"
                    type="checkbox"
                    disabled={options.effort !== 'high'}
                    checked={options.imageAnalysis}
                    onChange={(event) => setOptions((current) => ({ ...current, imageAnalysis: event.target.checked }))}
                  />
                </label>

                {options.backend === 'pipeline' && (
                  <label className="setting-row" title="仅 Pipeline 后端使用，用于选择 OCR 识别模型">
                    <span>OCR 语言</span>
                    <select
                      value={options.language}
                      onChange={(event) => setOptions((current) => ({ ...current, language: event.target.value }))}
                    >
                      <option value="ch">中英日韩（默认）</option>
                      <option value="ch_server">中英日韩高精度</option>
                      <option value="korean">韩文</option>
                      <option value="ta">泰米尔文</option>
                      <option value="te">泰卢固文</option>
                      <option value="ka">卡纳达文</option>
                      <option value="th">泰文</option>
                      <option value="el">希腊文</option>
                      <option value="arabic">阿拉伯语系</option>
                      <option value="east_slavic">东斯拉夫语系</option>
                      <option value="cyrillic">西里尔语系</option>
                      <option value="devanagari">天城文语系</option>
                    </select>
                  </label>
                )}

                <div className="settings-subheading">输出设置</div>

                <label className="setting-row setting-row-required" title="content_list_v2 通过 ZIP 结果返回">
                  <span>ZIP</span>
                  <input className="switch" type="checkbox" checked disabled />
                </label>

                <label className="setting-row">
                  <span>Markdown</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.outputMarkdown}
                    onChange={(event) => setOptions((current) => ({ ...current, outputMarkdown: event.target.checked }))}
                  />
                </label>

                <label className="setting-row setting-row-required" title="content_list_v2 是页面的主数据源">
                  <span>Content list v2</span>
                  <input className="switch" type="checkbox" checked disabled />
                </label>

                <label className="setting-row">
                  <span>Image</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.outputImages}
                    onChange={(event) => setOptions((current) => ({ ...current, outputImages: event.target.checked }))}
                  />
                </label>

                <label className="setting-row">
                  <span>Middle JSON</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.outputMiddleJson}
                    onChange={(event) => setOptions((current) => ({ ...current, outputMiddleJson: event.target.checked }))}
                  />
                </label>

                <label className="setting-row">
                  <span>Model output</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.outputModelOutput}
                    onChange={(event) => setOptions((current) => ({ ...current, outputModelOutput: event.target.checked }))}
                  />
                </label>

                <label className="setting-row">
                  <span>Original file</span>
                  <input
                    className="switch"
                    type="checkbox"
                    checked={options.outputOriginalFile}
                    onChange={(event) => setOptions((current) => ({ ...current, outputOriginalFile: event.target.checked }))}
                  />
                </label>
              </div>
            )}
          </section>
        </aside>
      </section>
    </main>
  )
}
