'use client'

import { useEffect, useState } from 'react'
import { CloseIcon } from '@/components/icons'
import { api } from '@/lib/api-client'
import { dayKey, dayLabel } from '@/lib/calendar'
import { LOCATION_LABEL, LOCATIONS } from '@/lib/clinic'
import type { NewAppointment } from '@/hooks/useAgenda'
import type { AgendaWeek, Location } from '@/lib/types'
import { AdvisorSelect, lastAdvisor, rememberAdvisor } from './AdvisorSelect'
import styles from './Agenda.module.css'

type Props = {
  week: AgendaWeek
  seed: { day: string; start: string; location: Location }
  busy: boolean
  onClose: () => void
  onSubmit: (input: NewAppointment) => void
  onRemoveAdvisor: (name: string) => void
}

type Slots = { starts: string[]; closed: string | null }

/**
 * Alta manual. Las horas disponibles se piden al servidor para el servicio elegido, así que
 * el operador solo puede escoger huecos que de verdad existen (y la creación los revalida).
 */
export function NewBookingForm({ week, seed, busy, onClose, onSubmit, onRemoveAdvisor }: Props) {
  const [kind, setKind] = useState<'appointment' | 'block'>('appointment')
  const [location, setLocation] = useState<Location>(seed.location)
  const [day, setDay] = useState(seed.day)
  const [serviceId, setServiceId] = useState(week.services[0]?.id ?? '')
  const [start, setStart] = useState(seed.start)
  // Indicativo por defecto +57; "Otro" deja escribir cualquier indicativo (clientes del exterior).
  const [dial, setDial] = useState('57')
  const [otherDial, setOtherDial] = useState('')
  const [phone, setPhone] = useState('')
  const dialCode = dial === 'other' ? otherDial.replace(/\D/g, '') : dial
  // Si pegan el número completo ("573001234567" o "+57 300…"), no se duplica el indicativo.
  const national = phone.replace(/\D/g, '').replace(new RegExp(`^(00)?${dialCode}(?=\\d{7,})`), '').replace(/^0+/, '')
  const fullPhone = dialCode && national ? `${dialCode}${national}` : ''
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  // Quién agenda: se recuerda el último en este navegador para no escribirlo en cada cita.
  const [advisor, setAdvisor] = useState('')
  useEffect(() => { setAdvisor(lastAdvisor()) }, [])
  const removeAdvisor = (name: string) => { onRemoveAdvisor(name); if (advisor === name) setAdvisor('') }
  // En la vista mensual llegan 42 días: solo se ofrecen los que todavía se pueden agendar.
  const today = dayKey()
  const days = week.days.filter((item) => item >= today || item === seed.day)
  const [slots, setSlots] = useState<Slots | null>(null)
  const [pair, setPair] = useState(false)
  // Pareja = dos cabinas a la vez: solo se ofrece en sedes con al menos dos.
  const canPair = kind === 'appointment' && (week.cabins[location] ?? 1) >= 2
  const people = canPair && pair ? 2 : 1

  useEffect(() => {
    if (!serviceId) return
    let active = true
    setSlots(null)
    api<Slots>(`/api/agenda/slots?location=${location}&day=${day}&service=${serviceId}&people=${people}`)
      .then((data) => { if (active) setSlots(data) })
      .catch(() => { if (active) setSlots({ starts: [], closed: null }) })
    return () => { active = false }
  }, [location, day, serviceId, people])

  // Si la hora sembrada ya no cabe para el servicio elegido, se ofrece la primera que sí.
  useEffect(() => {
    if (slots && slots.starts.length && !slots.starts.includes(start)) setStart(slots.starts[0])
  }, [slots, start])

  const canSubmit = Boolean(start) && (kind === 'block' || (fullPhone.length >= 8 && fullPhone.length <= 15 && name.trim() && serviceId && advisor.trim()))

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
            {days.map((item) => <option key={item} value={item}>{dayLabel(item)}</option>)}
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

        {canPair && (
          <label>
            <span className="eyebrow">Personas</span>
            <select value={people} onChange={(event) => setPair(event.target.value === '2')}>
              <option value={1}>1 persona</option>
              <option value={2}>2 personas a la vez (pareja 2x1)</option>
            </select>
          </label>
        )}

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
              <div className={styles.phoneRow}>
                <select value={dial} onChange={(event) => setDial(event.target.value)} aria-label="Indicativo del país">
                  <option value="57">🇨🇴 +57</option>
                  <option value="1">🇺🇸 +1</option>
                  <option value="52">🇲🇽 +52</option>
                  <option value="593">🇪🇨 +593</option>
                  <option value="34">🇪🇸 +34</option>
                  <option value="other">Otro…</option>
                </select>
                {dial === 'other' && (
                  <input className={styles.dialInput} value={otherDial} inputMode="numeric" maxLength={4} placeholder="+__" aria-label="Otro indicativo" onChange={(event) => setOtherDial(event.target.value)} />
                )}
                <input value={phone} inputMode="tel" onChange={(event) => setPhone(event.target.value)} placeholder={dial === '57' ? '300 123 4567' : 'Número'} />
              </div>
              {fullPhone && <small className={styles.dim}>Se guarda como +{fullPhone}</small>}
            </label>
            <label>
              <span className="eyebrow">Asesor</span>
              <AdvisorSelect value={advisor} onChange={setAdvisor} options={week.advisors ?? []} onRemove={removeAdvisor} />
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
          onClick={() => {
            if (kind === 'appointment') rememberAdvisor(advisor)
            onSubmit({ kind, location, day, start, serviceId, phone: fullPhone, name: name.trim(), notes, people, advisor: advisor.trim() })
          }}
        >
          {kind === 'block' ? 'Bloquear' : 'Crear cita confirmada'}
        </button>
        {kind === 'appointment' && <p className={styles.dim}>Lo que agendas a mano queda confirmado: no espera anticipo.</p>}
      </div>
    </aside>
  )
}
