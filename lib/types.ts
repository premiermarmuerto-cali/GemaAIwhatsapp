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
  /** Anuncio de Meta (clic a WhatsApp) desde el que llegó el cliente; viene solo en el primer mensaje. */
  ad?: { headline?: string; body?: string; sourceId?: string; ctwaClid?: string }
  /** El cliente tocó un botón de una plantilla (respuesta rápida): su payload, si la plantilla lo define. */
  buttonPayload?: string
  /** Mensaje enviado por una automatización (seguimiento o plantilla), no por Gema en conversación. */
  auto?: string
  /**
   * Plantilla de Meta que salió (lib/template-text.ts): cuál, con qué variables y si la envió una persona
   * desde el panel. `text` es el texto aprobado ya completo, o un resumen si Meta no lo entregó.
   */
  template?: { name: string; params: Record<string, string>; manual: boolean }
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
  /** Cuándo se pidió el asesor (0 si nunca). */
  agentAt: number
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
  /** Último pago confirmado por Bold, para el aviso emergente del panel. */
  paymentNotice: string
  paymentNoticeAt: number
  /** Tocó "Ahora no" en una plantilla de marketing: no se le vuelven a enviar. */
  noMarketing: boolean
  /**
   * Dijo "no me interesa", "ahora no" o similar: no recibe NINGÚN mensaje automático (seguimientos,
   * recordatorios ni plantillas) hasta que agende o el operador lo reactive. Evita reportes de spam.
   */
  optedOut: boolean
  /** Cuándo lo dijo (0 si nunca) y con qué palabras, para mostrarlo en el panel. */
  optedOutAt: number
  optedOutText: string
  /** Celular que dio un cliente con número oculto (ver Booking.contactPhone). */
  contactPhone: string
  /** Anuncio de origen (atribución): id del anuncio en Meta y clic. */
  adSourceId: string
  adHeadline: string
  ctwaClid: string
  /** Momento del primer mensaje con ctwa_clid (≈ clic en el anuncio): Meta atribuye hasta 7 días después. */
  ctwaAt: number
  /** Automatizaciones ya enviadas a este chat: tipo → momento del envío (evita repetirlas). */
  autoSent: Record<string, number>
  /** Objeción que frenó la venta, para medirla (hoy: 'efectivo', quiso pagar en efectivo). */
  objection: string
  /** Último evento de conversión enviado a Meta (JSON: evento, ok, motivo, momento). '' si ninguno. */
  capiStatus: string
}

export type ChatDetail = ChatSummary & { messages: Message[] }

export type ChatLists = Record<Box, ChatSummary[]>

export type ChatPatch = { botActive?: boolean; stage?: Stage; archived?: boolean; needsAgent?: false; optedOut?: false }

/** Lo que Gema extrae del prospecto mientras conversa; se muestra en el panel y viaja a la cita. */
export type Lead = {
  /** Motivo de consulta en palabras del cliente: acné, manchas, poros, resequedad… */
  concern: string
  serviceId: string
  location: Location | ''
  /** Día que el cliente pidió para su cita (YYYY-MM-DD), de lo que dijo en la conversación (lib/preferences.ts). */
  day?: string
  /** Franja que pidió: mañana, tarde o noche. */
  part?: string
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
  /** Cabina asignada, desde 1. Con `people` > 1 ocupa también las siguientes (cabin … cabin + people - 1). */
  cabin: number
  /** Personas de la cita: 2 en el 2x1 de pareja. */
  people: number
  /**
   * Pareja en una sede de una sola cabina: las dos sesiones van una después de la otra (la segunda
   * empieza al terminar la primera). Entonces `durationMin` es el tiempo total de cabina.
   */
  sequential: boolean
  /** Qué pagó o debe pagar para reservar: el anticipo o la sesión completa. `deposit` es ese monto. */
  /** cash: agendada sin anticipo, paga todo en la sede (config.cashBooking). Confirmada pero NO pagada. */
  /** courtesy: limpieza de cortesía (la sede la regala por compra de productos): no se cobra. */
  paymentPlan: 'deposit' | 'full' | 'cash' | 'courtesy'
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
  /** Quién generó la cita y a quién le corresponde: "Gema" si la agendó ella, o el nombre del asesor. */
  advisor: string
  createdAt: number
  /** Epoch ms hasta el que el horario sigue apartado sin pago. 0 si ya no aplica. */
  holdUntil: number
  paidAt: number
  confirmedAt: number
  /** Medio con el que se pagó el anticipo por Bold (PSE, CREDIT_CARD, NEQUI). Vacío si lo validó un operador. */
  paymentMethod: string
  /** payment_id de Bold. Vacío si el anticipo no pasó por Bold. */
  paymentRef: string
  /** Link de Bold generado para el anticipo de esta cita; se guarda para poder reenviarlo. */
  paymentLink: string
  /**
   * Celular de contacto que dio un cliente con número oculto (usuario de WhatsApp): su "phone" es un
   * identificador sin número, y así la sede lo puede llamar. Vacío si no lo dio o si no hace falta.
   */
  contactPhone: string
  /** Nombre completo de la segunda persona (2x1 de pareja). Vacío si la cita es individual. */
  companion: string
  /** El cliente confirmó que asiste (botón "Confirmo mi cita" o mensaje). No es lo mismo que pagada. */
  attendanceConfirmedAt: number
  /** Automatizaciones ya enviadas por esta cita (recordatorios, seguimiento del pago): tipo → momento. */
  autoSent: Record<string, number>
}

/** Rango continuo de cabina libre dentro de un día. */
export type FreeWindow = { day: string; from: string; to: string; minutes: number }

export type DayAvailability = { day: string; location: Location; windows: FreeWindow[]; closed: boolean }

// ─────────────────────────── Configuración ───────────────────────────

/**
 * Mensajes prediseñados que envía el servidor tal cual (no la IA), editables en el panel. Admiten
 * variables entre llaves ({nombre}, {promos}, {horarios}…, ver lib/presets.ts) y ||| para partir en
 * varios mensajes de WhatsApp.
 */
export type PresetMessages = {
  /** Bienvenida 1: pie de la imagen del 2x1 (máx. 1024 caracteres ya completo). */
  welcomeCaption: string
  /** Bienvenida 2: el valor (ritual de 5 pasos, cero invasiva, qué resuelve cada limpieza). */
  welcomeValue: string
  /** Bienvenida 3: cómo se separa, horarios libres y una sola pregunta. */
  welcomeClose: string
  /** ~30 min antes de que se libere un horario apartado sin pago. */
  followUpPayment: string
  /** ~45 min sin respuesta, sin cita. */
  followUp45: string
  /** ~3 h sin respuesta, sin cita. */
  followUp3h: string
  /** ~22 h sin respuesta: último mensaje antes de que se cierre la ventana de 24 h. */
  followUp22h: string
}

export type PresetId = keyof PresetMessages

export type AppConfig = {
  /** Versión de la configuración guardada: lib/config.ts aplica los cambios de cada versión al leerla. */
  revision: number
  systemPrompt: string
  services: Service[]
  /**
   * Horario de agendamiento. Siete entradas, índice 0 = domingo. Cada franja "HH:MM-HH:MM" es
   * primera–última hora de INICIO de una cita: la sesión puede terminar después de la segunda.
   */
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
  /**
   * Anticipo fijo en pesos por cita (p. ej. 50000), igual para todos los servicios. 0 = se usa
   * depositPercent. Nunca supera el valor de la cita.
   */
  depositFixed: number
  /**
   * Quien quiere pagar en efectivo se agenda sin anticipo (cita confirmada, paga todo en la sede) y
   * recibe recordatorios un día antes y unas 2 h antes. false = se le explica el anticipo y, si
   * insiste, pasa a Johanna.
   */
  cashBooking: boolean
  /**
   * Cortesía para quien separa con anticipo (p. ej. "una exfoliación de manos con sal del Mar
   * Muerto"). Gema la usa para cerrar y queda en las notas de la cita. Vacío = sin cortesía.
   */
  depositPerk: string
  /** Mensajes prediseñados (bienvenida y seguimientos). */
  messages: PresetMessages
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
  /** Contexto de la marca Premier (por qué es premium, productos de cada limpieza). Vacío = no se usa. */
  brandInfo: string
  /** Promoción vigente, tal como Gema la debe comunicar (p. ej. el 2x1). Vacío = no hay promoción. */
  promo: string
  /**
   * Reglas del 2x1 de pareja que el servidor aplica al cobrar: id de servicio → fecha de la última
   * sesión incluida (YYYY-MM-DD, inclusive; '' = sin fecha límite). Dos personas a la misma hora
   * pagan una sesión solo en esos servicios y fechas; fuera de eso, dos sesiones.
   */
  twoForOne: Record<string, string>
}

/** Lo que el panel necesita para pintar una semana completa (o un mes: 6 semanas de lunes a domingo). */
export type AgendaWeek = {
  days: string[]
  /** Solo en la vista mensual: el mes que se pinta, YYYY-MM (los días de los bordes son de otros meses). */
  month?: string
  bookings: Booking[]
  closed: Record<string, string>
  hours: string[][]
  slotMinutes: number
  cabins: Record<Location, number>
  addresses: Record<Location, string>
  services: Array<Pick<Service, 'id' | 'label' | 'durationMin' | 'price'>>
  /** Asesores guardados, para elegirlos de una lista al agendar o reasignar una cita. */
  advisors: string[]
}

export type DailyStats ={ inbound: number; aiReplies: number; humanReplies: number; booked: number; newChats: number }

export type Stats = { inbox: number; archived: number; today: DailyStats }
