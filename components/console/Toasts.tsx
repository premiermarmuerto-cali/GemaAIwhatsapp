'use client'

import { CloseIcon } from '@/components/icons'
import type { Toast } from '@/hooks/useToast'
import styles from './Toasts.module.css'

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={styles.toast} data-tone={toast.tone} role={toast.tone === 'error' ? 'alert' : 'status'}>
          <span className={`dot ${toast.tone === 'error' ? 'dot-error' : 'dot-ai'}`} />
          <span className={styles.text}>{toast.text}</span>
          {toast.action && (
            <button className={styles.action} onClick={() => { toast.action!.run(); onDismiss(toast.id) }}>{toast.action.label}</button>
          )}
          <button className={styles.close} onClick={() => onDismiss(toast.id)} aria-label="Cerrar aviso"><CloseIcon /></button>
        </div>
      ))}
    </div>
  )
}
