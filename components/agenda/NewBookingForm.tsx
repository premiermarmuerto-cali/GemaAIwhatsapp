'use client'

import { useEffect, useState } from 'react'
import { CloseIcon } from '@/components/icons'
import { api } from '@/lib/api-client'
import { dayLabel } from '@/lib/calendar'
import { LOCATION_LABEL, LOCATIONS } from '@/lib/clinic'
import type { NewAppointment } from '@/hooks/useAgenda'
import type { AgendaWeek, Location } from '@/lib/types'
import styles from './Agenda.module.css'

type Props = {
  week: AgendaWeek
  seed: { day: string; start: string; location: Location }
  busy: boolean
  onClose: () => void
  onSubmit: (input: NewAppointment) => void
}

type Slots = { starts: string[]; closed: string | null }

/**
 * Alta manual. Las horas disponibles se piden al servidor para el servicio elegido, así que
 * el operador solo puede escoger huecos que de verdad existen (y la creación los revalida).
 */
export function NewBookingForm({ week, seed, busy, onClose, onSubmit }: Props) {
  const [kind, setKind] = useState<'appointment' | 'block'>('appointment')
  const [location, setLocation] = useState<Location>(seed.location)
  const [day, setDay] = useState(seed.day)
  const [serviceId, setServiceId] = useState(week.services[0]?.id ?? '')
  const [start, setStart] = useState(seed.start)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [slots, setSlots] = useState<Slots | null>(null)

  useEffect(() => {
    if (!serviceId) return
    let active = true
    setSlots(null)
    api<Slots>(`/api/agenda/slots?location=${location}&day=${day}&service=${serviceId}`)
      .then((data) => { if (active) setSlots(data) })
      .catch(() => { if (active) setSlots({ starts: [], closed: null }) })
    return () => { active = false }
  }, [location, day, serviceId])

  // Si la hora sembrada ya no cabe para el servicio elegido, se ofrece la primera que sí.
  useEffect(() => {
    if (slots && slots.starts.length && !slots.starts.includes(start)) setStart(slots.starts[0])
  }, [slots, start])

  const canSubmit = Boolean(start) && (kind === 'block' || (phone.replace(/\D/g, '').length >= 8 && name.trim() && serviceId))

  return (
    <aside className={styles.panel} aria-label="Nueva cita">
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>{kind === 'block' ? 'Bloquear horario' : 'Nueva cita'}</h2>
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Cerrar"><CloseIcon /></button>
      </header>

      <div className={styles.tabs} role="tablist">
        {(['appointment', 'block'] as const).map((option) => (
          <button key={option} role="tab" aria-selected={kind === option} className={styles.tab} onClick={() => setKind(option)}>
            {option === 'appointment' ? 'Cita' : 'Bloqueo'}
          </button>
        ))}
      </div>

      <div className={styles.form}>
        <label>
          <span className="eyebrow">Sede</span>
          <select value={location} onChange={(event) => setLocation(event.target.value as Location)}>
            {LOCATIONS.map((item) => <option key={item} value={item}>{LOCATION_LABEL[item]}</option>)}
          </select>
        </label>

        <label>
          <span className="eyebrow">Día</span>
          <select value={day} onChange={(event) => setDay(event.target.value)}>
            {week.days.map((item) => <option key={item} value={item}>{dayLabel(item)}</option>)}
          </select>
        </label>

        <label>
          <span className="eyebrow">Servicio</span>
          <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
            {week.services.map((service) => (
              <option key={service.id} value={service.id}>{service.label} · {service.durationMin} min</option>
            ))}
          </select>
        </label>

        <div className={styles.field}>
          <span className="eyebrow">Hora</span>
          {slots === null ? (
            <p className={styles.dim}>Buscando huecos…</p>
          ) : slots.closed ? (
            <p className={styles.dim}>Ese día está cerrado: {slots.closed}</p>
          ) : slots.starts.length === 0 ? (
            <p className={styles.dim}>No queda espacio para este servicio ese día.</p>
          ) : (
            <div className={styles.slotPicker}>
              {slots.starts.map((option) => (
                <button key={option} type="button" className={styles.slotOption} aria-pressed={option === start} onClick={() => setStart(option)}>
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>

        {kind === 'appointment' && (
          <>
            <label>
              <span className="eyebrow">Nombre</span>
              <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Nombre completo" />
            </label>
            <label>
              <span className="eyebrow">WhatsApp</span>
              <input value={phone} inputMode="tel" onChange={(event) => setPhone(event.target.value)} placeholder="573001234567" />
            </label>
          </>
        )}

        <label>
          <span className="eyebrow">{kind === 'block' ? 'Motivo' : 'Notas'}</span>
          <textarea value={notes} rows={2} maxLength={1000} onChange={(event) => setNotes(event.target.value)} placeholder={kind === 'block' ? 'Almuerzo, inventario, capacitación…' : 'Lo que el cliente nos contó'} />
        </label>

        <button
          className="btn btn-primary"
          disabled={busy || !canSubmit}
          onClick={() => onSubmit({ kind, location, day, start, serviceId, phone, name: name.trim(), notes })}
        >
          {kind === 'block' ? 'Bloquear' : 'Crear cita confirmada'}
        </button>
        {kind === 'appointment' && <p className={styles.dim}>Lo que agendas a mano queda confirmado: no espera anticipo.</p>}
      </div>
    </aside>
  )
}
