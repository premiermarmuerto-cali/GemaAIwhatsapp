'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowIcon, BackIcon, CalendarIcon, ChatIcon, ClockIcon, PlusIcon } from '@/components/icons'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Toasts } from '@/components/console/Toasts'
import { useAgenda } from '@/hooks/useAgenda'
import { useToast } from '@/hooks/useToast'
import { addDays, dayKey, dayLabel } from '@/lib/calendar'
import { LOCATION_LABEL, LOCATIONS } from '@/lib/clinic'
import type { Booking, Location } from '@/lib/types'
import { BookingPanel } from './BookingPanel'
import { holdCountdown } from './labels'
import { NewBookingForm } from './NewBookingForm'
import { WeekGrid } from './WeekGrid'
import styles from './Agenda.module.css'

type Aside =
  | { mode: 'booking'; id: string }
  | { mode: 'new'; day: string; start: string; location: Location }
  | null

export function Agenda() {
  const { toasts, show, dismiss } = useToast()
  const agenda = useAgenda(show)
  const [location, setLocation] = useState<Location>('unicentro')
  const [aside, setAside] = useState<Aside>(null)

  const week = agenda.week
  const selected = useMemo(
    () => (aside?.mode === 'booking' ? week?.bookings.find((booking) => booking.id === aside.id) ?? null : null),
    [aside, week],
  )

  // Lo primero que un operador necesita ver: quién pagó y está esperando que le confirmen.
  const awaiting = useMemo(
    () => (week?.bookings ?? []).filter((booking) => booking.status === 'pending_payment').sort((a, b) => b.paidAt - a.paidAt),
    [week],
  )

  const closedReason = week?.closed ?? {}
  const today = dayKey()
  const thisWeek = agenda.days.includes(today)

  const openBooking = (booking: Booking) => setAside({ mode: 'booking', id: booking.id })

  return (
    <div className={styles.shell} data-aside={aside ? 'open' : undefined}>
      <header className={styles.top}>
        <div className={styles.brand}>
          <span className={`brand-mark ${styles.mark}`} aria-hidden="true" />
          <span className={styles.wordmark}>Premier Mar Muerto</span>
          <span className="eyebrow">Agenda</span>
        </div>

        <div className={styles.topEnd}>
          <Link className="btn btn-ghost" href="/"><ChatIcon /><span className={styles.hideSmall}>Conversaciones</span></Link>
          <ThemeToggle />
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.nav}>
          <button className="btn btn-secondary btn-icon" onClick={() => agenda.goTo(addDays(agenda.anchor, -7))} aria-label="Semana anterior"><BackIcon /></button>
          <button className="btn btn-secondary" onClick={() => agenda.goTo(today)} disabled={thisWeek}><CalendarIcon />Hoy</button>
          <button className="btn btn-secondary btn-icon" onClick={() => agenda.goTo(addDays(agenda.anchor, 7))} aria-label="Semana siguiente"><ArrowIcon /></button>
          <span className={styles.range}>{dayLabel(agenda.days[0], { short: true })} – {dayLabel(agenda.days[6], { short: true })}</span>
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Sede">
          {LOCATIONS.map((item) => (
            <button key={item} role="tab" aria-selected={location === item} className={styles.tab} onClick={() => setLocation(item)}>
              {LOCATION_LABEL[item]}
              {week && <span className={styles.tabCount}>{week.bookings.filter((booking) => booking.location === item).length}</span>}
            </button>
          ))}
        </div>

        <button className="btn btn-primary" onClick={() => setAside({ mode: 'new', day: today, start: '', location })}><PlusIcon />Nueva cita</button>
      </div>

      {awaiting.length > 0 && (
        <div className={styles.queue}>
          <span className="eyebrow"><ClockIcon /> Esperando validación del anticipo</span>
          <ul>
            {awaiting.map((booking) => (
              <li key={booking.id}>
                <button className={styles.queueItem} onClick={() => openBooking(booking)}>
                  <b>{booking.name || booking.phone}</b>
                  <span>{dayLabel(booking.day, { short: true })} · {booking.start} · {LOCATION_LABEL[booking.location]}</span>
                  <span className={styles.dim}>{booking.paidAt ? 'comprobante recibido' : `se libera en ${holdCountdown(booking.holdUntil)}`}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <main className={styles.main}>
        {agenda.loadError ? (
          <div className={styles.empty}>
            <p>{agenda.loadError}</p>
            <button className="btn btn-secondary" onClick={agenda.refresh}>Reintentar</button>
          </div>
        ) : !week ? (
          <div className={styles.empty}><p className={styles.dim}>Cargando la agenda…</p></div>
        ) : (
          <>
            <WeekGrid
              week={week}
              location={location}
              activeId={selected?.id ?? null}
              onSelect={openBooking}
              onPick={(day, start) => setAside({ mode: 'new', day, start, location })}
            />
            <div className={styles.dayTools}>
              {week.days.map((day) => (
                <button
                  key={day}
                  className={styles.dayTool}
                  data-closed={closedReason[day] ? true : undefined}
                  disabled={agenda.busy}
                  onClick={() => agenda.closeDay(day, closedReason[day] ? null : 'Cerrado por el equipo')}
                  title={closedReason[day] ? `Reabrir ${dayLabel(day)}` : `Cerrar ${dayLabel(day)}`}
                >
                  {closedReason[day] ? 'Reabrir' : 'Cerrar'} {dayLabel(day, { short: true }).split(' ')[0]}
                </button>
              ))}
            </div>
          </>
        )}
      </main>

      {selected && (
        <BookingPanel
          booking={selected}
          busy={agenda.busy}
          onClose={() => setAside(null)}
          onStatus={async (id, status) => {
            await agenda.setStatus(id, status)
            if (status === 'cancelled') setAside(null)
          }}
          onAnnotate={(id, notes) => void agenda.annotate(id, notes)}
        />
      )}

      {aside?.mode === 'new' && week && (
        <NewBookingForm
          week={week}
          seed={{ day: aside.day, start: aside.start, location: aside.location }}
          busy={agenda.busy}
          onClose={() => setAside(null)}
          onSubmit={async (input) => {
            const created = await agenda.create(input)
            if (created) setAside({ mode: 'booking', id: created.id })
          }}
        />
      )}

      {aside?.mode === 'booking' && !selected && week && (
        <aside className={styles.panel}>
          <p className={styles.dim}>Esa cita ya no está en esta semana. Puede que se haya cancelado o reprogramado.</p>
          <button className="btn btn-secondary" onClick={() => setAside(null)}>Cerrar</button>
        </aside>
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
      <p className="sr-only" role="status">{week ? `${week.bookings.length} citas esta semana. ${awaiting.length} esperando validación.` : ''}</p>
    </div>
  )
}
