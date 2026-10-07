'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { ArrowIcon, CloseIcon, PlusIcon, TrashIcon } from '@/components/icons'
import type { ShowToast } from '@/hooks/useToast'
import { api } from '@/lib/api-client'
import { LOCATION_LABEL, LOCATIONS, WEEKDAY_LABEL } from '@/lib/clinic'
import type { AppConfig, Location, Region, Service } from '@/lib/types'
import styles from './SettingsModal.module.css'

/** Campos numéricos con su rango y su explicación: evita repetir el mismo bloque cinco veces. */
const NUMBERS: Array<{ key: 'depositPercent' | 'slotMinutes' | 'leadTimeHours' | 'horizonDays' | 'holdMinutes'; label: string; min: number; max: number; hint: string }> = [
  { key: 'depositPercent', label: 'Anticipo %', min: 1, max: 100, hint: 'Porcentaje que se cobra para reservar.' },
  { key: 'slotMinutes', label: 'Grilla (min)', min: 5, max: 60, hint: 'Cada duración de servicio debe ser múltiplo de este número.' },
  { key: 'leadTimeHours', label: 'Antelación (h)', min: 0, max: 72, hint: 'Lo mínimo que debe faltar para poder agendar.' },
  { key: 'horizonDays', label: 'Horizonte (días)', min: 1, max: 90, hint: 'Hasta cuándo se puede agendar hacia adelante.' },
  { key: 'holdMinutes', label: 'Apartado (min)', min: 15, max: 2880, hint: 'Cuánto aguanta un horario sin anticipo pagado.' },
]

export function SettingsModal({ onClose, toast }: { onClose: () => void; toast: ShowToast }) {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // La vista previa se pide por región, como en la consola original: el prompt cambia según el país.
  const [preview, setPreview] = useState<{ region: Region; prompt: string } | null>(null)

  useEffect(() => {
    api<AppConfig>('/api/settings').then(setConfig).catch((reason: Error) => setError(reason.message))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patch = (changes: Partial<AppConfig>) => setConfig((current) => (current ? { ...current, ...changes } : current))

  const text = (name: 'systemPrompt' | 'faq' | 'payLink' | 'nequiInstructions' | 'intlInstructions') => ({
    value: config?.[name] ?? '',
    onChange: (event: { target: { value: string } }) => patch({ [name]: event.target.value } as Partial<AppConfig>),
  })

  function patchService(index: number, changes: Partial<Service>) {
    setConfig((current) => current && { ...current, services: current.services.map((service, at) => (at === index ? { ...service, ...changes } : service)) })
  }

  async function showPreview(region: Region) {
    if (preview?.region === region) return setPreview(null)
    try {
      const { prompt } = await api<{ prompt: string }>(`/api/settings/preview?region=${region}`)
      setPreview({ region, prompt })
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'No se pudo generar la vista previa.', { tone: 'error' })
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!config) return
    setSaving(true)
    setError('')
    try {
      setConfig(await api<AppConfig>('/api/settings', { method: 'PUT', body: config }))
      toast('Configuración guardada · Gema la usará desde el próximo mensaje')
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  const missingPrices = config?.services.filter((service) => !service.price) ?? []

  return (
    <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="settings-title" onSubmit={save}>
        <header className={styles.header}>
          <div>
            <span className="eyebrow">Config / Global</span>
            <h2 id="settings-title">Gema y la agenda</h2>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Cerrar"><CloseIcon /></button>
        </header>

        {!config && !error && <p className={styles.loading}>Cargando configuración…</p>}

        {config && (
          <div className={styles.body}>
            <label className={styles.field}>
              <span>Voz de Gema</span>
              <textarea rows={6} maxLength={6000} required {...text('systemPrompt')} />
              <small>Personalidad y objetivo. El catálogo, las sedes, la disponibilidad real y las reglas de cobro se añaden solas en cada mensaje.</small>
            </label>

            <fieldset className={styles.group}>
              <legend>Catálogo</legend>
              {config.services.map((service, index) => (
                <div key={service.id} className={styles.row}>
                  <label className={styles.field}>
                    <span>Servicio</span>
                    <input value={service.label} maxLength={80} onChange={(event) => patchService(index, { label: event.target.value })} />
                  </label>
                  <label className={styles.field} style={{ maxWidth: 96 }}>
                    <span>Min</span>
                    <input value={service.durationMin} inputMode="numeric" onChange={(event) => patchService(index, { durationMin: Number(event.target.value) || 0 })} />
                  </label>
                  <label className={styles.field} style={{ maxWidth: 140 }}>
                    <span>Precio</span>
                    <input value={service.price} maxLength={60} placeholder="$120.000" onChange={(event) => patchService(index, { price: event.target.value })} />
                  </label>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`Quitar ${service.label}`}
                    disabled={config.services.length === 1}
                    onClick={() => patch({ services: config.services.filter((_, at) => at !== index) })}
                  ><TrashIcon /></button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => patch({ services: [...config.services, { id: `servicio-${config.services.length + 1}`, label: '', durationMin: config.slotMinutes * 2, price: '', summary: '' }] })}
              ><PlusIcon />Añadir servicio</button>
              <small className={styles.hint}>La duración debe ser múltiplo de la grilla ({config.slotMinutes} min). El id se usa en las marcas de Gema y no se puede cambiar aquí.</small>
            </fieldset>

            <fieldset className={styles.group}>
              <legend>Horario de atención</legend>
              {config.hours.map((ranges, index) => (
                <label key={index} className={styles.row} style={{ alignItems: 'center' }}>
                  <span className={styles.dayName}>{WEEKDAY_LABEL[index]}</span>
                  <input
                    value={ranges.join(', ')}
                    placeholder="cerrado"
                    onChange={(event) => patch({ hours: config.hours.map((day, at) => (at === index ? event.target.value.split(',').map((item) => item.trim()).filter(Boolean) : day)) })}
                  />
                </label>
              ))}
              <small className={styles.hint}>Formato 10:00-20:00. Varias franjas separadas por coma, en orden y sin solaparse. Vacío = cerrado.</small>
            </fieldset>

            <fieldset className={styles.group}>
              <legend>Sedes</legend>
              {LOCATIONS.map((location: Location) => (
                <div key={location} className={styles.row}>
                  <label className={styles.field}>
                    <span>{LOCATION_LABEL[location]} · dirección</span>
                    <input
                      value={config.addresses[location]}
                      maxLength={200}
                      onChange={(event) => patch({ addresses: { ...config.addresses, [location]: event.target.value } })}
                    />
                  </label>
                  <label className={styles.field} style={{ maxWidth: 96 }}>
                    <span>Cabinas</span>
                    <input
                      value={config.cabins[location]}
                      inputMode="numeric"
                      onChange={(event) => patch({ cabins: { ...config.cabins, [location]: Number(event.target.value) || 1 } })}
                    />
                  </label>
                </div>
              ))}
            </fieldset>

            <fieldset className={styles.group}>
              <legend>Cobro del anticipo</legend>
              <label className={styles.field}>
                <span>Link de pago (opcional)</span>
                <input placeholder="https://… (link fijo del anticipo)" maxLength={500} {...text('payLink')} />
                <small>Gema nunca escribe estos datos: el sistema los añade cuando la cabina queda apartada de verdad.</small>
              </label>
              <label className={styles.field}>
                <span><span className="badge badge-region">+57</span> Colombia · COP</span>
                <textarea rows={2} maxLength={1500} placeholder="Número de Nequi, titular, cuenta Bancolombia o Daviplata y qué debe enviar como comprobante" {...text('nequiInstructions')} />
              </label>
              <label className={styles.field}>
                <span><span className="badge badge-region">Resto</span> Internacional · USD</span>
                <textarea rows={3} maxLength={1500} placeholder="Binance Pay ID, enlace de PayPal, datos de Wise o cuenta ACH de DolarApp" {...text('intlInstructions')} />
              </label>
              <div className={styles.row}>
                {NUMBERS.map((item) => (
                  <label key={item.key} className={styles.field} title={item.hint}>
                    <span>{item.label}</span>
                    <input
                      value={config[item.key]}
                      inputMode="numeric"
                      onChange={(event) => patch({ [item.key]: Number(event.target.value) || item.min } as Partial<AppConfig>)}
                    />
                  </label>
                ))}
              </div>
            </fieldset>

            <label className={styles.field}>
              <span>Preguntas frecuentes e indicaciones</span>
              <textarea rows={4} maxLength={4000} placeholder="Llegar sin maquillaje, no exponerse al sol 48 h después, cuánto duran los resultados…" {...text('faq')} />
            </label>

            {!config.payLink && !config.nequiInstructions && (
              <p className={styles.warning}>Sin link ni datos para Colombia, Gema aparta el horario pero pasa el cobro a un asesor.</p>
            )}
            {!config.payLink && !config.intlInstructions && (
              <p className={styles.warning}>Sin link ni datos internacionales, los clientes de fuera de Colombia pasan a un asesor para pagar.</p>
            )}
            {missingPrices.length > 0 && (
              <p className={styles.warning}>Sin precio: {missingPrices.map((service) => service.label || service.id).join(', ')}. Gema no los cotiza ni los agenda.</p>
            )}

            <div className={styles.preview}>
              <div className={styles.previewTabs}>
                <span className="eyebrow">Lo que recibe Gema</span>
                {(['CO', 'INTL'] as Region[]).map((region) => (
                  <button key={region} type="button" aria-pressed={preview?.region === region} onClick={() => showPreview(region)}>
                    {region === 'CO' ? 'Colombia' : 'Internacional'}
                  </button>
                ))}
              </div>
              {preview && <pre>{preview.prompt}</pre>}
              <small className={styles.hint}>Es el prompt real, con la disponibilidad de esta semana. Lo guardado arriba se refleja al reabrirlo.</small>
            </div>
          </div>
        )}

        <footer className={styles.footer}>
          <p className={styles.error} role="alert">{error}</p>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={!config || saving}>{saving ? 'Guardando…' : 'Guardar'}<ArrowIcon /></button>
        </footer>
      </form>
    </div>
  )
}
