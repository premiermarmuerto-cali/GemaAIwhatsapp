/**
 * Plantillas aprobadas en Meta (WABA 1997545614294706), tal como están registradas el 18 oct 2026.
 * Sin dependencias de servidor: la usa también el panel para mostrar qué plantilla le llegó al cliente.
 *
 * `language`: el idioma con el que se REGISTRARON, no el del texto. Tres quedaron como "English"
 * aunque están en español; si el código no coincide, Meta responde 132001.
 * `image`: archivo en public/plantillas/ para el encabezado de imagen.
 * `buttons`: llegan al webhook como mensaje de tipo "button" con su texto.
 */
export const TEMPLATES = {
  retomar_cita_limpieza: { language: 'es_CO', image: 'plantilla_retomar_cita.jpg', label: 'Retomar la conversación', buttons: ['Sí, quiero agendar', 'Tengo una pregunta', 'Ahora no'] },
  anticipo_pendiente: { language: 'en', label: 'Anticipo pendiente', buttons: ['Enviar link', 'Cambiar horario', 'Ahora no'] },
  ultimos_dias_bono: { language: 'en', image: 'plantilla_ultimos_dias_bono.jpg', label: 'Últimos días del 2x1', buttons: ['Sí, agéndame', 'Tengo una duda', 'Ahora no'] },
  recordatorio_cita: { language: 'en', label: 'Recordatorio de la cita', buttons: ['Confirmo mi cita', 'Reagendar', 'No podré asistir'] },
} as const satisfies Record<string, { language: string; image?: string; label: string; buttons: readonly string[] }>
export type TemplateName = keyof typeof TEMPLATES

export const isTemplateName = (value: string): value is TemplateName => value in TEMPLATES

/** Nombre legible de cada variable, para cuando no se tiene el texto aprobado. */
export const PARAM_LABEL: Record<string, string> = {
  nombre_cliente: 'Nombre',
  fecha_cita: 'Fecha',
  hora_cita: 'Hora',
  sede: 'Sede',
  oferta: 'Cierre del 2x1',
}

/**
 * Mensajes de plantilla guardados antes de que existiera `Message.template` (texto "[Plantilla
 * "recordatorio_cita" enviada · nombre_cliente: Lina · …]"): se leen igual para mostrarlos en el panel.
 */
export function parseTemplateSummary(text: string): { name: TemplateName; params: Record<string, string>; manual: boolean } | null {
  const match = /^\[Plantilla "(\w+)" enviada( desde el panel)?((?: · [^·\]]+)*)\]$/.exec(text.trim())
  if (!match || !isTemplateName(match[1])) return null
  const params = Object.fromEntries(match[3].split(' · ').filter(Boolean).map((pair) => {
    const at = pair.indexOf(': ')
    return at === -1 ? [pair.trim(), ''] : [pair.slice(0, at).trim(), pair.slice(at + 2).trim()]
  }))
  return { name: match[1], params, manual: Boolean(match[2]) }
}
