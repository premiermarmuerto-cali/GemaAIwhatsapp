export type Sender = 'user' | 'gem' | 'human'
/** booked: el chat ya produjo una cita. */
export type Stage = 'open' | 'booked'
export type Box = 'inbox' | 'archived'
/** Colombia cobra en COP (Nequi y transferencia); cualquier otro país se atiende en USD. */
export type Region = 'CO' | 'INTL'

/** help: Gema pidió una persona. payment: llegó comprobante, falta validar el anticipo y confirmar la cita. */
export type AgentKind = 'help' | 'payment'

export type MediaKind = 'image' | 'audio' | 'document' | 'video'

export type MessageMedia = {
  kind: MediaKind
  /** ID del archivo en Meta; también es la clave de la copia guardada. */
  id: string
  mime?: string
  filename?: string
  /** Se calculan al leer: estado de la copia y lo que Gema entendió (análisis de imagen o transcripción). */
  status?: 'processing' | 'ready' | 'failed' | 'expired'
  note?: string
}

export type Message = {
  id: string
  sender: Sender
  /** Texto del mensaje o, si trae archivo, el pie de foto. */
  text: string
  at: number
  media?: MessageMedia
  /** Solo en el cliente: estado del envío optimista. */
  pending?: 'sending' | 'failed'
}

export type ChatSummary = {
  phone: string
  name: string
  country: string
  region: Region
  stage: Stage
  archived: boolean
  botActive: boolean
  /** Gema (o un archivo del cliente) pidió que una persona atienda el chat. */
  needsAgent: boolean
  agentKind: AgentKind
  agentReason: string
  unread: number
  lastMessage: string
  lastSender: Sender
  lastAt: number
  lastInboundAt: number
  /** Última imagen recibida (posible comprobante); la consola avisa cuando cambia. */
  lastImageAt: number
  createdAt: number
  /** Ficha del prospecto que Gema fue llenando durante la conversación. */
  lead: Lead
  /** Cita viva de este chat (hold, pendiente de pago o confirmada), si existe. */
  bookingId: string
}

export type ChatDetail = ChatSummary & { messages: Message[] }

export type ChatLists = Record<Box, ChatSummary[]>

export type ChatPatch = { botActive?: boolean; stage?: Stage; archived?: boolean; needsAgent?: false }

/** Lo que Gema extrae del prospecto mientras conversa; se muestra en el panel y viaja a la cita. */
export type Lead = {
  /** Motivo de consulta en palabras del cliente: acné, manchas, poros, resequedad… */
  concern: string
  serviceId: string
  location: Location | ''
}

// ─────────────────────────── Agenda ───────────────────────────

export type Location = 'unicentro' | 'chipichape'

export type Service = {
  id: string
  label: string
  /** Minutos de cabina que ocupa el protocolo. */
  durationMin: number
  /** Precio ya formateado en COP. Vacío = NO CONFIGURADO: Gema no puede cotizarlo. */
  price: string
  summary: string
}

/**
 * hold        → Gema apartó el horario mientras el cliente decide (vida corta).
 * pending_payment → se envió el link del anticipo; el horario sigue apartado hasta holdUntil.
 * confirmed   → el operador validó el anticipo.
 * done        → la sesión se realizó.
 * no_show     → no asistió.
 * cancelled   → se liberó el horario.
 */
export type BookingStatus = 'hold' | 'pending_payment' | 'confirmed' | 'done' | 'no_show' | 'cancelled'

/** Los estados que siguen ocupando cabina. */
export const LIVE_STATUSES: BookingStatus[] = ['hold', 'pending_payment', 'confirmed']

/** Los dos primeros se liberan solos si nadie paga. */
export const HOLD_STATUSES: BookingStatus[] = ['hold', 'pending_payment']

export type Booking = {
  id: string
  /** block: bloqueo manual del operador (almuerzo, inventario, cita externa). */
  kind: 'appointment' | 'block'
  phone: string
  name: string
  location: Location
  /** Cabina asignada, desde 1. */
  cabin: number
  serviceId: string
  serviceLabel: string
  durationMin: number
  /** YYYY-MM-DD en la zona de la clínica. */
  day: string
  /** HH:MM de inicio. */
  start: string
  /** Minutos desde medianoche: sirve para ordenar y para pintar la grilla. */
  startMin: number
  /** Epoch ms del inicio, ya resuelto en la zona de la clínica. */
  startTs: number
  status: BookingStatus
  price: string
  deposit: string
  concern: string
  notes: string
  source: 'bot' | 'operator'
  createdAt: number
  /** Epoch ms hasta el que el horario sigue apartado sin pago. 0 si ya no aplica. */
  holdUntil: number
  paidAt: number
  confirmedAt: number
}

/** Rango continuo de cabina libre dentro de un día. */
export type FreeWindow = { day: string; from: string; to: string; minutes: number }

export type DayAvailability = { day: string; location: Location; windows: FreeWindow[]; closed: boolean }

// ─────────────────────────── Configuración ───────────────────────────

export type AppConfig = {
  systemPrompt: string
  services: Service[]
  /** Siete entradas, índice 0 = domingo. Cada franja "HH:MM-HH:MM". */
  hours: string[][]
  cabins: Record<Location, number>
  addresses: Record<Location, string>
  /** Link de pago fijo y preexistente del anticipo. Vacío = Gema cobra solo con los datos de abajo. */
  payLink: string
  /** Datos de cobro para clientes en Colombia (Nequi, Bancolombia, Daviplata…). */
  nequiInstructions: string
  /** Datos de cobro para clientes fuera de Colombia. */
  intlInstructions: string
  /** Porcentaje del anticipo que se exige para reservar. */
  depositPercent: number
  /** Granularidad de la grilla en minutos. */
  slotMinutes: number
  /** Antelación mínima para agendar, en horas. */
  leadTimeHours: number
  /** Cuántos días hacia adelante se puede agendar. */
  horizonDays: number
  /** Minutos que un horario queda apartado sin anticipo pagado. */
  holdMinutes: number
  /** Preguntas frecuentes e indicaciones previas que Gema puede citar. */
  faq: string
}

/** Lo que el panel necesita para pintar una semana completa. */
export type AgendaWeek = {
  days: string[]
  bookings: Booking[]
  closed: Record<string, string>
  hours: string[][]
  slotMinutes: number
  cabins: Record<Location, number>
  addresses: Record<Location, string>
  services: Array<Pick<Service, 'id' | 'label' | 'durationMin' | 'price'>>
}

export type DailyStats ={ inbound: number; aiReplies: number; humanReplies: number; booked: number; newChats: number }

export type Stats = { inbox: number; archived: number; today: DailyStats }
