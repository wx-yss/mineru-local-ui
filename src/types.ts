export type DocumentStatus = 'submitting' | 'pending' | 'processing' | 'completed' | 'failed'

export interface ParseOptions {
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

export interface MineruEndpoint {
  id: string
  name: string
  url: string
}

export interface DocumentMeta {
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

export interface ContentV2Span {
  type: string
  content: string
}

export interface ContentV2ListItem {
  item_type: string
  item_content: ContentV2Span[]
}

export interface ContentV2BlockContent {
  level?: number
  title_content?: ContentV2Span[]
  paragraph_content?: ContentV2Span[]
  page_header_content?: ContentV2Span[]
  page_footer_content?: ContentV2Span[]
  page_number_content?: ContentV2Span[]
  page_aside_text_content?: ContentV2Span[]
  page_footnote_content?: ContentV2Span[]
  image_source?: { path: string }
  image_caption?: ContentV2Span[]
  image_footnote?: ContentV2Span[]
  chart_caption?: ContentV2Span[]
  chart_footnote?: ContentV2Span[]
  table_caption?: ContentV2Span[]
  table_footnote?: ContentV2Span[]
  html?: string
  math_content?: string
  math_type?: string
  list_type?: string
  attribute?: string
  list_items?: ContentV2ListItem[]
  code_caption?: ContentV2Span[]
  code_content?: ContentV2Span[]
  code_footnote?: ContentV2Span[]
  code_language?: string
  algorithm_caption?: ContentV2Span[]
  algorithm_content?: ContentV2Span[]
  algorithm_footnote?: ContentV2Span[]
  content?: string
}

export interface ContentV2Block {
  type: string
  bbox: [number, number, number, number]
  content: ContentV2BlockContent
}

export type ContentListV2 = ContentV2Block[][]

export interface ParsedFileResult {
  content_list_v2: string
  md_content?: string
  middle_json?: string
  model_output?: string
  images?: Record<string, string>
}

export interface MinerUResultPayload {
  backend?: string
  version?: string
  results?: Record<string, ParsedFileResult>
}

export interface DocumentDetail extends DocumentMeta {
  result: MinerUResultPayload | null
}

export interface HealthState {
  available: boolean
  status?: string
  version?: string
  url: string
  error?: string
}

export interface LinkedBlock {
  id: string
  pageIndex: number
  order: number
  pageSize: [number, number]
  block: ContentV2Block
}
