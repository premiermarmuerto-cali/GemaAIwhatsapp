'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api-client'
import { dayKey } from '@/lib/calendar'
import { LOCATION_LABEL, LOCATIONS } from '@/lib/clinic'
import { isWhatsAppUserId } from '@/lib/phone'
import type { AgendaWeek, Booking, Location } from '@/lib/types'
import styles from './Agenda.module.css'

type Props = {
  booking: Booking
  services: AgendaWeek['services']
  busy: boolean
  onCancel: () => void
  /** Solo lo que cambió. Fecha, hora, sede y servicio viajan juntos (es una reprogramación). */
  onSave: (changes: Record<string, unknown>) => Promise<unknown>
}

type Slots = { starts: string[]; closed: string | null }

/**
 * Editar una cita desde el panel: datos de la persona y, si hace falta, servicio, sede, día y hora.
 * Las horas se piden al servidor contando como libres las casillas de esta misma cita, así se puede
 * mover 15 minutos o cambiar de servicio sin chocar consigo misma. El servidor vuelve a comprobar.
 */
export function EditBookingForm({ booking, services, busy, onCancel, onSave }: Props) {
  const hidden = isWhatsAppUserId(booking.phone)
  const [name, setName] = useState(booking.name)
  const [companion, setCompanion] = useState(booking.companion)
  const [phone, setPhone] = useState(booking.phone ? `+${booking.phone}` : '')
  const [contactPhone, setContactPhone] = useState(booking.contactPhone ? `+${booking.contactPhone}` : '')
  const [serviceId, setServiceId] = useState(booking.serviceId)
  const [location, setLocation] = useState<Location>(booking.location)
  const [day, setDay] = useState(booking.day)
  const [start, setStart] = useState(booking.start)
  const [slots, setSlots] = useState<Slots | null>(null)
  // Cómo paga. Una cita de Gema esperando el anticipo se valida con "Confirmar anticipo", no aquí.
  const initialPayment = booking.paymentPlan === 'cash' ? 'onsite' : booking.paymentPlan === 'full' ? 'full' : 'deposit'
  const [payment, setPayment] = useState<'onsite' | 'deposit' | 'full'>(initialPayment)
  const awaitingPayment = booking.status !== 'confirmed'

  useEffect(() => {
    let active = true
    setSlots(null)
    api<Slots>(`/api/agenda/slots?location=${location}&day=${day}&service=${serviceId}&people=${booking.people}&exclude=${booking.id}`)
      .then((data) => { if (active) setSlots(data) })
      .catch(() => { if (active) setSlots({ starts: [], closed: null }) })
    return () => { active = false }
  }, [location, day, serviceId, booking.people, booking.id])

  const moved = serviceId !== booking.serviceId || location !== booking.location || day !== booking.day || start !== booking.start
  const startOk = !moved || Boolean(slots?.starts.includes(start))

  async function save() {
    const changes: Record<string, unknown> = {}
    if (name.trim() !== booking.name) changes.name = name.trim()
    if (booking.people > 1 && companion.trim() !== booking.companion) changes.companion = companion.trim()
    if (!hidden && phone.replace(/\D/g, '') !== booking.phone) changes.phone = phone
    if (hidden && contactPhone.replace(/\D/g, '') !== booking.contactPhone) changes.contactPhone = contactPhone
    if (moved) Object.assign(changes, { day, start, location, serviceId })
    if (!awaitingPayment && payment !== initialPayment) changes.payment = payment
    if (!Object.keys(changes).length) return onCancel()
    await onSave(changes)
  }

  return (
    <div className={styles.form}>
      <label>
        <span className="eyebrow">Nombre</span>
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      {booking.people > 1 && (
        <label>
          <span className="eyebrow">Acompañante</span>
          <input value={companion} maxLength={80} onChange={(event) => setCompanion(event.target.value)} />
        </label>
      )}
      {hidden ? (
        <label>
          <span className="eyebrow">Celular de contacto</span>
          <input value={contactPhone} inputMode="tel" placeholder="+57 300 123 4567" onChange={(event) => setContactPhone(event.target.value)} />
          <small className={styles.dim}>El cliente escribe con número oculto: este es el celular para llamarlo. Los mensajes de WhatsApp le siguen llegando igual.</small>
        </label>
      ) : (
        <label>
          <span className="eyebrow">WhatsApp</span>
          <input value={phone} inputMode="tel" placeholder="+57 300 123 4567" onChange={(event) => setPhone(event.target.value)} />
          <small className={styles.dim}>Con indicativo. Un celular colombiano de 10 dígitos se completa con +57.</small>
        </label>
      )}
      {!awaitingPayment && (
        <label>
          <span className="eyebrow">Pago</span>
          <select value={payment} onChange={(event) => setPayment(event.target.value as typeof payment)}>
            <option value="onsite">No ha pagado: paga todo en la sede</option>
            <option value="deposit">Ya pagó el anticipo</option>
            <option value="full">Ya pagó la sesión completa</option>
          </select>
        </label>
      )}
      <label>
        <span className="eyebrow">Servicio</span>
        <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
          {services.map((service) => <option key={service.id} value={service.id}>{service.label} · {service.durationMin} min</option>)}
        </select>
      </label>
      <label>
        <span className="eyebrow">Sede</span>
        <select value={location} onChange={(event) => setLocation(event.target.value as Location)}>
          {LOCATIONS.map((item) => <option key={item} value={item}>{LOCATION_LABEL[item]}</option>)}
        </select>
      </label>
      <label>
        <span className="eyebrow">Día</span>
        <input type="date" value={day} min={dayKey()} onChange={(event) => event.target.value && setDay(event.target.value)} />
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
              <button key={option} type="button" className={styles.slotOption} aria-pressed={option === start} onClick={() => setStart(option)}>{option}</button>
            ))}
          </div>
        )}
        {moved && !startOk && slots && <small className={styles.dim}>Elige una hora libre.</small>}
      </div>
      {moved && serviceId !== booking.serviceId && <p className={styles.dim}>Al cambiar de servicio se recalcula el valor. Lo que ya se pagó se conserva.</p>}
      <div className={styles.editActions}>
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !startOk} onClick={() => void save()}>Guardar cambios</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  )
}
