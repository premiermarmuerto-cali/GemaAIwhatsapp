'use client'

import { dayKey, dayLabel } from '@/lib/calendar'
import { WEEKDAY_SHORT } from '@/lib/clinic'
import type { AgendaWeek, Booking, Location } from '@/lib/types'
import { STATUS_LABEL } from './labels'
import styles from './Agenda.module.css'

/** Citas que se listan por día antes de resumir el resto en "+N más". */
const PER_DAY = 4

type Props = {
  week: AgendaWeek
  location: Location
  activeId: string | null
  onSelect: (booking: Booking) => void
  /** Clic en el número del día (o en "+N más"): abre esa semana en la vista por horas. */
  onPickDay: (day: string) => void
}

/** Vista mensual: seis semanas de lunes a domingo con las citas de la sede, en orden de hora. */
export function MonthGrid({ week, location, activeId, onSelect, onPickDay }: Props) {
  const today = dayKey()
  const headers = [1, 2, 3, 4, 5, 6, 0].map((index) => WEEKDAY_SHORT[index])

  return (
    <div className={styles.month}>
      {headers.map((name) => <div key={name} className={styles.monthHead}>{name}</div>)}
      {week.days.map((day) => {
        const items = week.bookings.filter((booking) => booking.day === day && booking.location === location).sort((a, b) => a.startMin - b.startMin)
        const appointments = items.filter((booking) => booking.kind !== 'block').length
        const closed = week.closed[day]
        return (
          <div
            key={day}
            className={styles.monthCell}
            data-outside={week.month && !day.startsWith(week.month) ? true : undefined}
            data-today={day === today || undefined}
            data-closed={closed ? true : undefined}
          >
            <div className={styles.monthCellHead}>
              <button type="button" className={styles.monthDay} onClick={() => onPickDay(day)} title={`Ver la semana del ${dayLabel(day)}`}>
                {Number(day.slice(8))}
              </button>
              {closed ? <span className={styles.monthNote}>cerrado</span> : appointments > 0 && <span className={styles.monthNote}>{appointments} {appointments === 1 ? 'cita' : 'citas'}</span>}
            </div>
            <ul className={styles.monthList}>
              {items.slice(0, PER_DAY).map((booking) => (
                <li key={booking.id}>
                  <button
                    type="button"
                    className={styles.monthEvent}
                    data-status={booking.status}
                    data-kind={booking.kind}
                    data-active={booking.id === activeId || undefined}
                    onClick={() => onSelect(booking)}
                    title={`${booking.start} · ${booking.name || booking.notes || 'Bloqueo'} · ${booking.serviceLabel} · ${STATUS_LABEL[booking.status]}${booking.advisor ? ` · Asesor: ${booking.advisor}` : ''}`}
                  >
                    <time>{booking.start}</time>
                    <span>{booking.kind === 'block' ? (booking.notes || 'Bloqueado') : (booking.name || booking.phone)}</span>
                  </button>
                </li>
              ))}
              {items.length > PER_DAY && (
                <li><button type="button" className={styles.monthMore} onClick={() => onPickDay(day)}>+{items.length - PER_DAY} más</button></li>
              )}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
