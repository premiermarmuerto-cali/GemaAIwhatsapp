'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowIcon, BackIcon, CalendarIcon, ChatIcon, ClockIcon, PlusIcon } from '@/components/icons'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Toasts } from '@/components/console/Toasts'
import { useAgenda } from '@/hooks/useAgenda'
import { useToast } from '@/hooks/useToast'
import { addDays, addMonths, dayKey, dayLabel, monthLabel } from '@/lib/calendar'
import { LOCATION_LABEL, LOCATIONS } from '@/lib/clinic'
import type { Booking, Location } from '@/lib/types'
import { APP_VERSION } from '@/lib/version'
import { BookingPanel } from './BookingPanel'
import { holdCountdown } from './labels'
import { AdvisorManager } from './AdvisorManager'
import { MonthGrid } from './MonthGrid'
import { NewBookingForm } from './NewBookingForm'
import { WeekGrid } from './WeekGrid'
import styles from './Agenda.module.css'

type Aside =
  | { mode: 'booking'; id: string }
  | { mode: 'new'; day: string; start: string; location: Location }
  | { mode: 'advisors' }
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
  const monthView = agenda.view === 'month'
  // "Hoy" se apaga cuando el periodo que se ve ya contiene el día de hoy.
  const showingToday = monthView ? agenda.anchor.slice(0, 7) === today.slice(0, 7) : agenda.days.includes(today)
  const step = (direction: 1 | -1) => agenda.goTo(monthView ? addMonths(agenda.anchor, direction) : addDays(agenda.anchor, 7 * direction))
  // Las citas de la sede que se ven en el mes (no las de los días de otros meses en los bordes).
  const inPeriod = (booking: Booking) => !week?.month || booking.day.startsWith(week.month)

  const openBooking = (booking: Booking) => setAside({ mode: 'booking', id: booking.id })

  return (
    <div className={styles.shell} data-aside={aside ? 'open' : undefined}>
      <header className={styles.top}>
        <div className={styles.brand}>
          <span className={`brand-mark ${styles.mark}`} aria-hidden="true" />
          <span className={styles.wordmark}>Premier Mar Muerto</span>
          <span className="eyebrow">Agenda</span>
          <span className="version-tag" title="Versión del panel">v{APP_VERSION}</span>
        </div>

        <div className={styles.topEnd}>
          <Link className="btn btn-ghost" href="/"><ChatIcon /><span className={styles.hideSmall}>Conversaciones</span></Link>
          <ThemeToggle />
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.nav}>
          <button className="btn btn-secondary btn-icon" onClick={() => step(-1)} aria-label={monthView ? 'Mes anterior' : 'Semana anterior'}><BackIcon /></button>
          <button className="btn btn-secondary" onClick={() => agenda.goTo(today)} disabled={showingToday}><CalendarIcon />Hoy</button>
          <button className="btn btn-secondary btn-icon" onClick={() => step(1)} aria-label={monthView ? 'Mes siguiente' : 'Semana siguiente'}><ArrowIcon /></button>
          <span className={styles.range}>
            {monthView ? monthLabel(agenda.anchor) : `${dayLabel(agenda.days[0], { short: true })} – ${dayLabel(agenda.days[6], { short: true })}`}
          </span>
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Vista">
          {(['week', 'month'] as const).map((mode) => (
            <button key={mode} role="tab" aria-selected={agenda.view === mode} className={styles.tab} onClick={() => agenda.setView(mode)}>
              {mode === 'week' ? 'Semana' : 'Mes'}
            </button>
          ))}
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Sede">
          {LOCATIONS.map((item) => (
            <button key={item} role="tab" aria-selected={location === item} className={styles.tab} onClick={() => setLocation(item)}>
              {LOCATION_LABEL[item]}
              {week && <span className={styles.tabCount}>{week.bookings.filter((booking) => booking.location === item && inPeriod(booking)).length}</span>}
            </button>
          ))}
        </div>

        <div className={styles.legend} aria-label="Colores de las citas">
          <span data-source="bot">Gema</span>
          <span data-source="operator">Equipo</span>
          <span data-status="pending_payment">Reserva (falta anticipo)</span>
        </div>

        <button className="btn btn-secondary" onClick={() => setAside({ mode: 'advisors' })} title="Editar o quitar nombres de asesores">Asesores</button>
        <button className="btn btn-primary" onClick={() => setAside({ mode: 'new', day: today, start: '', location })}><PlusIcon />Nueva cita</button>
      </div>

      {awaiting.length > 0 && (
        <div className={styles.queue}>
          <span className="eyebrow"><ClockIcon /> Reservas sin anticipo confirmado</span>
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
        ) : monthView ? (
          <MonthGrid
            week={week}
            location={location}
            activeId={selected?.id ?? null}
            onSelect={openBooking}
            onPickDay={(day) => { agenda.goTo(day); agenda.setView('week') }}
          />
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
          onAdvisor={(id, advisor) => void agenda.setAdvisor(id, advisor)}
          advisors={week?.advisors ?? []}
          services={week?.services ?? []}
          onEdit={(id, changes) => agenda.edit(id, changes)}
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

      {aside?.mode === 'advisors' && (
        <AdvisorManager
          advisors={week?.advisors ?? []}
          busy={agenda.busy}
          onClose={() => setAside(null)}
          onRename={(from, to) => void agenda.renameAdvisor(from, to)}
          onRemove={(name) => void agenda.removeAdvisor(name)}
        />
      )}

      {aside?.mode === 'booking' && !selected && week && (
        <aside className={styles.panel}>
          <p className={styles.dim}>Esa cita ya no está en {monthView ? 'este mes' : 'esta semana'}. Puede que se haya cancelado o reprogramado.</p>
          <button className="btn btn-secondary" onClick={() => setAside(null)}>Cerrar</button>
        </aside>
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
      <p className="sr-only" role="status">{week ? `${week.bookings.filter(inPeriod).length} citas ${monthView ? 'este mes' : 'esta semana'}. ${awaiting.length} esperando validación.` : ''}</p>
    </div>
  )
}
