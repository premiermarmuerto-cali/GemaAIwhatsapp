/**
 * El cliente pide que no le escriban más: "no me interesa", "ahora no", "no gracias", "deja de
 * escribirme"… (Premier, 20 oct 2026). Se detienen todos sus mensajes automáticos para que no nos
 * reporte como spam: Meta baja la calidad del número y limita los envíos cuando la gente bloquea.
 *
 * Solo cuenta si el mensaje ES eso. "La de manchas no me interesa, la de peeling sí" o "ahora no
 * puedo, mejor el sábado" siguen siendo una conversación de venta.
 */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Mensajes completos que son un "no" a seguir recibiendo mensajes (el botón "Ahora no" incluido). */
const WHOLE = /^(ahora no|por ahora no|no por ahora|ahora no gracias|por el momento no|no por el momento|no gracias|no muchas gracias|no gracias por ahora|no ya no|ya no|no mas|no quiero|no estoy interesad[oa]|no me interesa|ya no me interesa)$/

/** Frases que, en un mensaje corto, piden parar. */
const PHRASES = /\b(no (me|nos) interesa|no estoy interesad[oa]|ya no (me )?interesa|no quiero (mas|recibir|que me) |deja(r|n)? de (escribir|enviar|mandar)|no (me|nos) (escribas|escriban|escriba|envies|envien|mandes|manden|vuelvas? a escribir)|no (me )?molest(es|en|e)\b|no (mas|quiero) mensajes|stop\b|cancelar suscripcion|eliminame|borrame|sacame de)/

/** Señales de que sigue interesado en algo (entonces no es una baja). */
const STILL_INTERESTED = /\b(pero|aunque|(la|el) de|si|tambien|quiero (agendar|reservar|la|el|una|saber)|me interesa (la|el|una)|si me interesa|cuanto|precio|agend|reserv|cita|horario|disponib|otro dia|otra semana|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)|mas adelante te|despues te (escribo|aviso))\b/

export function isOptOut(text: string): boolean {
  const clean = fold(text).replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return false
  if (WHOLE.test(clean)) return true
  if (clean.split(' ').length > 16 || !PHRASES.test(`${clean} `)) return false
  return !STILL_INTERESTED.test(clean.replace(PHRASES, ' '))
}
