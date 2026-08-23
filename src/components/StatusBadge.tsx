import { AlertCircle, CheckCircle2, Clock3, LoaderCircle } from 'lucide-react'

import type { DocumentStatus } from '../types'

const labels: Record<DocumentStatus, string> = {
  submitting: '正在提交',
  pending: '等待解析',
  processing: '正在解析',
  completed: '解析完成',
  failed: '解析失败',
}

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const Icon =
    status === 'completed'
      ? CheckCircle2
      : status === 'failed'
        ? AlertCircle
        : status === 'pending'
          ? Clock3
          : LoaderCircle

  return (
    <span className={`status-badge status-${status}`}>
      <Icon size={13} className={status === 'processing' || status === 'submitting' ? 'spin' : ''} />
      {labels[status]}
    </span>
  )
}
