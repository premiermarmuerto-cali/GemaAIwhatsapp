'use client'

import { useEffect, useState } from 'react'
import { ChatIcon, CloseIcon, PinIcon } from '@/components/icons'
import { api } from '@/lib/api-client'
import { dayLabel, toClock, toMinutes } from '@/lib/calendar'
import { LOCATION_LABEL } from '@/lib/clinic'
import { formatPhone } from '@/lib/phone'
import type { Booking, BookingStatus } from '@/lib/types'
import { ACTION_LABEL, holdCountdown, NEXT_STATUSES, STATUS_LABEL } from './labels'
import styles from './Agenda.module.css'

type Props = {
  booking: Booking
  busy: boolean
  onClose: () => void
  onStatus: (id: string, status: BookingStatus) => void
  onAnnotate: (id: string, notes: string) => void
}

/** Ficha de la cita: lo que el bot extrajo del prospecto, el historial y las acciones del operador. */
export function BookingPanel({ booking, busy, onClose, onStatus, onAnnotate }: Props) {
  const [notes, setNotes] = useState(booking.notes)
  const [history, setHistory] = useState<Booking[]>([])

  useEffect(() => { setNotes(booking.notes) }, [booking.id, booking.notes])

  useEffect(() => {
    let active = true
    api<{ history: Booking[] }>(`/api/agenda/${booking.id}`)
      .then((data) => { if (active) setHistory(data.history) })
      .catch(() => { if (active) setHistory([]) })
    return () => { active = false }
  }, [booking.id])

  const ends = toClock(toMinutes(booking.start) + booking.durationMin)

  return (
    <aside className={styles.panel} aria-label="Ficha de la cita">
      <header className={styles.panelHead}>
        <div>
          <span className={`badge badge-status ${styles.panelBadge}`} data-status={booking.status}>{STATUS_LABEL[booking.status]}</span>
          <h2 className={styles.panelTitle}>{booking.kind === 'block' ? 'Horario bloqueado' : (booking.name || 'Sin nombre')}</h2>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Cerrar ficha"><CloseIcon /></button>
      </header>

      <dl className={styles.facts}>
        <div><dt>Servicio</dt><dd>{booking.serviceLabel}</dd></div>
        <div><dt>Cuándo</dt><dd>{dayLabel(booking.day)} · {booking.start}–{ends} <span className={styles.dim}>({booking.durationMin} min)</span></dd></div>
        <div><dt>Sede</dt><dd><PinIcon /> {LOCATION_LABEL[booking.location]}{(booking.cabin > 1) && ` · cabina ${booking.cabin}`}</dd></div>
        {booking.price && <div><dt>Valor</dt><dd>{booking.price}{booking.deposit && <span className={styles.dim}> · anticipo {booking.deposit}</span>}</dd></div>}
        {booking.phone && (
          <div>
            <dt>Cliente</dt>
            <dd>
              <a className={styles.link} href={`https://wa.me/${booking.phone}`} target="_blank" rel="noreferrer"><ChatIcon /> {formatPhone(booking.phone)}</a>
            </dd>
          </div>
        )}
        {booking.concern && <div><dt>Lo que nos contó</dt><dd className={styles.quote}>{booking.concern}</dd></div>}
        <div><dt>Origen</dt><dd>{booking.source === 'bot' ? 'Gema · WhatsApp' : 'Operador'}</dd></div>
        {booking.holdUntil > 0 && (
          <div><dt>Apartado</dt><dd>se libera en {holdCountdown(booking.holdUntil)}</dd></div>
        )}
        {booking.paidAt > 0 && (
          <div><dt>Comprobante</dt><dd>el cliente dice haber pagado{booking.confirmedAt ? ' · validado' : ' · pendiente de validar'}</dd></div>
        )}
      </dl>

      <div className={styles.notes}>
        <label htmlFor="booking-notes" className="eyebrow">Notas internas</label>
        <textarea
          id="booking-notes"
          value={notes}
          rows={3}
          maxLength={1000}
          placeholder="Alergias, sensibilidad, productos usados, acuerdos…"
          onChange={(event) => setNotes(event.target.value)}
        />
        <button className="btn btn-secondary" disabled={busy || notes === booking.notes} onClick={() => onAnnotate(booking.id, notes)}>Guardar nota</button>
      </div>

      {NEXT_STATUSES[booking.status].length > 0 && (
        <div className={styles.actions}>
          {NEXT_STATUSES[booking.status].map((status, index) => (
            <button
              key={status}
              className={`btn ${index === 0 ? 'btn-primary' : status === 'cancelled' ? 'btn-danger' : 'btn-secondary'}`}
              disabled={busy}
              onClick={() => onStatus(booking.id, status)}
            >
              {ACTION_LABEL[status]}
            </button>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className={styles.history}>
          <span className="eyebrow">Historial del cliente</span>
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <span>{dayLabel(item.day, { short: true })} · {item.start}</span>
                <span className={styles.dim}>{item.serviceLabel}</span>
                <span className="badge badge-status" data-status={item.status}>{STATUS_LABEL[item.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}
