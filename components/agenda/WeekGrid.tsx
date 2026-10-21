'use client'

import { dayKey, dayLabel, minuteOfDay, openRanges, toClock } from '@/lib/calendar'
import type { AgendaWeek, Booking, Location } from '@/lib/types'
import { holdCountdown, paymentState, paymentSummary, STATUS_LABEL } from './labels'
import styles from './Agenda.module.css'

/** Altura de un minuto en píxeles: 60 min = 78 px, lo justo para hora, nombre, servicio y pago · asesor. */
const PX_PER_MIN = 1.3
const HOUR = 60

type Props = {
  week: AgendaWeek
  location: Location
  activeId: string | null
  onSelect: (booking: Booking) => void
  /** Clic en un hueco: abre el formulario ya rellenado con ese día y esa hora. */
  onPick: (day: string, start: string) => void
}

/**
 * Primer y último minuto que hay que pintar. El horario marca la última hora de INICIO, así que
 * se deja espacio para que la cita más larga que empiece ahí termine dentro de la grilla.
 */
function bounds(week: AgendaWeek) {
  const ranges = week.days.flatMap((day) => openRanges(week.hours, day))
  if (!ranges.length) return { from: 9 * HOUR, to: 20 * HOUR }
  const longest = Math.max(week.slotMinutes, ...week.services.map((service) => service.durationMin))
  const from = Math.min(...ranges.map((range) => range.from))
  const to = Math.max(...ranges.map((range) => range.to)) + longest
  return { from: Math.floor(from / HOUR) * HOUR, to: Math.ceil(to / HOUR) * HOUR }
}

export function WeekGrid({ week, location, activeId, onSelect, onPick }: Props) {
  const { from, to } = bounds(week)
  const height = (to - from) * PX_PER_MIN
  const today = dayKey()
  const lanes = week.cabins[location] ?? 1

  const hourMarks = Array.from({ length: Math.ceil((to - from) / HOUR) + 1 }, (_, index) => from + index * HOUR)

  return (
    <div className={styles.grid} style={{ ['--grid-height' as string]: `${height}px` }}>
      <div className={styles.gutter}>
        <div className={styles.gutterHead} />
        <div className={styles.gutterBody}>
          {hourMarks.map((minute) => (
            <span key={minute} className={styles.hourMark} style={{ top: `${(minute - from) * PX_PER_MIN}px` }}>
              {toClock(minute)}
            </span>
          ))}
        </div>
      </div>

      {week.days.map((day) => {
        const ranges = openRanges(week.hours, day)
        const closed = week.closed[day]
        const items = week.bookings.filter((booking) => booking.day === day && booking.location === location)

        return (
          <div key={day} className={styles.column} data-today={day === today || undefined}>
            <div className={styles.columnHead}>
              <span className={styles.dayName}>{dayLabel(day, { short: true })}</span>
              <span className={styles.dayCount}>{closed ? 'cerrado' : `${items.length} ${items.length === 1 ? 'cita' : 'citas'}`}</span>
            </div>

            <div className={styles.columnBody}>
              {hourMarks.map((minute) => (
                <div key={minute} className={styles.hourLine} style={{ top: `${(minute - from) * PX_PER_MIN}px` }} />
              ))}

              {/* Fuera de horario se pinta apagado: así se ve de un vistazo dónde no se puede agendar. */}
              {closed || !ranges.length ? (
                <div className={styles.offHours} style={{ top: 0, height: `${height}px` }} title={closed || 'Cerrado'} />
              ) : (
                <>
                  <div className={styles.offHours} style={{ top: 0, height: `${(ranges[0].from - from) * PX_PER_MIN}px` }} />
                  {/* Apagado desde que pasa la última hora de inicio: después de eso no empieza ninguna cita. */}
                  <div className={styles.offHours} style={{ top: `${(ranges[ranges.length - 1].to + week.slotMinutes - from) * PX_PER_MIN}px`, height: `${(to - ranges[ranges.length - 1].to - week.slotMinutes) * PX_PER_MIN}px` }} />
                </>
              )}

              {/* Franjas clicables de la grilla: el operador agenda a mano pinchando el hueco. */}
              {!closed && ranges.flatMap((range) => {
                const slots: number[] = []
                for (let at = range.from; at <= range.to; at += week.slotMinutes) slots.push(at)
                return slots.map((minute) => (
                  <button
                    key={minute}
                    type="button"
                    className={styles.slot}
                    style={{ top: `${(minute - from) * PX_PER_MIN}px`, height: `${week.slotMinutes * PX_PER_MIN}px` }}
                    onClick={() => onPick(day, toClock(minute))}
                    aria-label={`Agendar el ${dayLabel(day)} a las ${toClock(minute)}`}
                  />
                ))
              })}

              {items.map((booking) => {
                const lane = Math.min(Math.max(booking.cabin, 1), lanes) - 1
                // Una pareja ocupa sus cabinas seguidas: se pinta como un solo bloque más ancho.
                const span = Math.min(Math.max(booking.people, 1), lanes - lane)
                return (
                  <button
                    key={booking.id}
                    type="button"
                    className={styles.event}
                    data-status={booking.status}
                    data-kind={booking.kind}
                    data-active={booking.id === activeId || undefined}
                    style={{
                      top: `${(booking.startMin - from) * PX_PER_MIN}px`,
                      height: `${Math.max(booking.durationMin * PX_PER_MIN - 2, 20)}px`,
                      left: `calc(${(lane * 100) / lanes}% + 2px)`,
                      width: `calc(${(span * 100) / lanes}% - 4px)`,
                    }}
                    onClick={() => onSelect(booking)}
                  >
                    <span className={styles.eventTime}>{booking.start}</span>
                    <span className={styles.eventName}>{booking.kind === 'block' ? (booking.notes || 'Bloqueado') : (booking.name || booking.phone)}</span>
                    <span className={styles.eventService}>{booking.serviceLabel}{booking.people > 1 && ` · ${booking.people} personas`}</span>
                    {/* Pago (o apartado) y asesor en una sola línea: con cinco líneas no cabían en una hora. */}
                    {booking.kind !== 'block' && (
                      <span className={styles.eventMeta}>
                        {booking.status === 'pending_payment'
                          ? <b className={styles.eventHold}>{STATUS_LABEL.pending_payment} · {holdCountdown(booking.holdUntil)}</b>
                          : booking.status === 'confirmed' && <b className={styles.eventPay} data-state={paymentState(booking)}>{paymentSummary(booking).short}</b>}
                        {booking.advisor && <span className={styles.eventAdvisor}>{booking.status === 'confirmed' || booking.status === 'pending_payment' ? ' · ' : ''}{booking.advisor}</span>}
                      </span>
                    )}
                  </button>
                )
              })}

              {/* Línea de "ahora", solo en la columna de hoy. */}
              {day === today && (() => {
                const minute = minuteOfDay()
                if (minute < from || minute > to) return null
                return <div className={styles.nowLine} style={{ top: `${(minute - from) * PX_PER_MIN}px` }} aria-hidden="true" />
              })()}
            </div>
          </div>
        )
      })}
    </div>
  )
}
