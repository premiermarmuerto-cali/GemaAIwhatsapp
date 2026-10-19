import type { MediaKind, Message } from './types'

export const MEDIA_LABEL: Record<MediaKind, string> = {
  image: 'Imagen',
  audio: 'Nota de voz',
  document: 'Documento',
  video: 'Video',
}

/** Texto corto para la lista de chats y las notificaciones. */
export function previewOf(message: Pick<Message, 'text' | 'media'>): string {
  if (!message.media) return message.text
  const label = MEDIA_LABEL[message.media.kind]
  return message.text ? `${label}: ${message.text}` : label
}

/** Cómo ve el modelo un mensaje: el anuncio de origen (si vino de uno) y el contenido del mensaje. */
export function modelText(message: Message): string {
  const ad = message.ad
  const origin = ad
    ? `[El cliente llegó desde un anuncio. Título: "${ad.headline ?? ''}"${ad.body ? `. Texto del anuncio: "${ad.body}"` : ''}]\n`
    : ''
  // Botón de una plantilla: Gema sabe que no es texto libre y a qué corresponde.
  // Textos de los botones de las plantillas aprobadas (ver TEMPLATES en lib/automations.ts).
  const button = message.buttonPayload !== undefined || /^\s*(ahora no|confirmo mi cita|no podr[eé] asistir|reagendar|cambiar horario|(re)?enviar (el )?link|tengo una (pregunta|duda)|s[ií], ag[eé]ndame|s[ií], quiero agendar)\s*$/i.test(message.text)
    ? '[El cliente tocó un botón de un mensaje automático] '
    : ''
  return origin + button + contentText(message)
}

/** La imagen descrita, el audio transcrito y el resto sin abrir. */
function contentText(message: Message): string {
  const media = message.media
  if (!media) return message.text
  const caption = message.text ? ` Texto que escribió junto al archivo: "${message.text}".` : ''
  const ready = media.status === 'ready' && media.note
  switch (media.kind) {
    case 'image':
      return ready ? `[Imagen enviada por el cliente. Lo que muestra: ${media.note}]${caption}` : `[Imagen enviada por el cliente que no se pudo analizar]${caption}`
    case 'audio':
      return ready ? `[Nota de voz del cliente, transcrita: "${media.note}"]` : '[Nota de voz del cliente que no se pudo transcribir]'
    case 'document':
      return `[El cliente envió un documento${media.filename ? ` llamado "${media.filename}"` : ''} que no puedes abrir]${caption}`
    case 'video':
      return `[El cliente envió un video que no puedes ver]${caption}`
  }
}
