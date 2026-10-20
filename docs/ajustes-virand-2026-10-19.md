# Ajustes al agente de WhatsApp · Premier Mar Muerto · Cali

Fecha: 19 oct 2026 · Preparado por VIRAND (Andrés) · Cliente: Premier Mar Muerto · Cali (Johanna)

> Documento recibido de VIRAND. Al final de cada sección hay una nota **Estado en Gema** con lo que se implementó y lo que queda pendiente. Las notas se agregaron el 20 de octubre de 2026.

Contexto corto: ya todas las rutas (anuncios, botón de la página, respuesta automática, preguntas frecuentes, bio de IG) dirigen al chat del agente. La pauta se concentró en una sola campaña (Ventas). Lo que hoy frena el resultado no es el tráfico, es lo que pasa **dentro del chat**: la gente pregunta, recibe el precio y el anticipo, y deja de contestar. Estos cambios atacan eso.

**Regla de oro (no tocar):** se vende la cita, no producto. Siempre "Premier Mar Muerto · Cali". Sin catálogo ni e-commerce. Sin promesas de resultado.

---

## 1. Pago en efectivo: no dejar perder al lead (PRIORIDAD 1)

**Problema:** el agente solo ofrece link de Bold o transferencia. Si la persona dice "yo pago en efectivo", "pago allá", "¿puedo pagar en el local?", el flujo se rompe y el lead se enfría.

**Instrucción al agente (system prompt):**

- Nunca responder "no se puede" ni cerrar la conversación ante "efectivo / pago allá".
- Reencuadrar: el anticipo no es un cobro extra, **es parte del valor de la limpieza y se descuenta del total**. Su función es reservar el cupo de cabina.
- Texto base (adaptar al tono de Gema, una sola idea y una sola pregunta):
  > "Claro, el resto lo pagas en la cabina el día de tu cita, en efectivo o como prefieras 😊 Solo te pedimos un anticipo de $50.000 que reserva tu cupo y que **se descuenta del valor de tu limpieza** (no es un costo adicional). ¿Te envío el link para separarlo y te confirmo hoy tu horario?"
- Si insiste en no pagar nada antes / solo efectivo:
  1. No discutir ni repetir el mismo argumento más de una vez.
  2. Marcar el chat en el panel con una etiqueta tipo `pago_efectivo` / `requiere_humano` y **avisar a Johanna** (notificación o campo visible en el panel) para que ella decida si hace una excepción.
  3. Responder al cliente: "Déjame confirmar con la sede y te escribo en unos minutos" y **no marcar el lead como perdido**.
  4. Si Johanna no responde en X minutos (definir con ella), volver con el cliente con la opción estándar y un horario concreto.
- Registrar el motivo (`objecion = efectivo`) para poder medir cuántos leads caen aquí.

**Pendiente de confirmar con Johanna (Andrés lo pregunta):** si acepta excepciones sin anticipo y para qué casos; política de reprogramación/devolución del anticipo (sugerencia: reprogramable con aviso de 24 h; sin aviso se pierde el anticipo).

---

## 2. Anticipo: valor fijo y descontable del precio de la limpieza (PRIORIDAD 1)

**Hoy:** anticipo = 50% del servicio ($65.000 en Peeling+Hidratación $130.000; $100.000 en Líneas de Expresión $200.000). Es lo que más asusta.

**Cambio:**

- Anticipo **fijo** (parámetro configurable, no escrito a mano en el prompt): `ANTICIPO_COP = 50000` como valor inicial (el documento de contexto del proyecto ya lo menciona; **Andrés confirma el valor final con Johanna** antes de activar).
- Mismo valor para ambos servicios.
- Siempre comunicarlo como **"se descuenta del valor de tu limpieza"** y mostrar la cuenta:
  > "Anticipo $50.000 hoy + $80.000 en cabina = $130.000" (o "+ $150.000" para Líneas de Expresión)
- Mantener Bold link o transferencia (sin cambios).
- Actualizar también las plantillas que mencionan el valor: `anticipo_pendiente` (registrada con idioma "English", se envía con código `en`), `recordatorio_cita` y cualquier texto que cite el monto. Si el monto va dentro del cuerpo de la plantilla aprobada, pasarlo como variable o re-enviar a aprobación.
- Verificar que el evento de Purchase (ver sección 5) use el valor realmente pagado (el anticipo), no el precio de lista.

---

## 3. NO cambiar el 2×1 por ahora

Decisión de VIRAND: **no tocar los mensajes del 2×1 en el agente.** Se mantiene tal cual está (Peeling+Hidratación $130.000 2×1 hasta 31 oct; Líneas de Expresión $200.000 2×1 sin fecha de fin). La corrección del enfoque de precio/valor se hará **desde los anuncios** (nuevo conjunto enfocado en el precio real y el valor). Cuando eso salga, avisamos si el agente necesita un ajuste.

---

## 4. Otros hallazgos del flujo (revisión de los 24 chats del panel)

| Hallazgo | Dato | Qué hacer |
|---|---|---|
| La gente deja de responder tras el primer mensaje | ~11 de 22 chats nunca contestan después de la primera respuesta del agente | Primer mensaje más corto y con **una sola pregunta** |
| El primer mensaje termina con dos preguntas | El usuario no sabe cuál contestar | Una sola pregunta, con opciones concretas: "¿Te queda mejor entre semana o fin de semana? Tengo martes 4 pm o sábado 10 am en Unicentro" |
| Seguimiento solo a las 22 h | `seguimiento_22h`: 1 de 11 respondió; plantilla `retomar_cita_limpieza` (`es_CO`): 0 de 9 | Añadir seguimientos **dentro de la ventana de 24 h**: ~30–60 min y ~3–4 h, cada uno con información nueva (no repetir), p. ej. sede/horarios disponibles, recordatorio de que el bono vence el 31 oct, cupos de la semana (solo si Johanna confirma que son reales) |
| Mensajes con imagen, audio o enlace | El bot dice que no puede abrirlos | Si es audio/imagen: responder que no puede verlo y retomar con la pregunta pendiente; si es muy frecuente, evaluar transcripción de audios |
| Sede | Dos sedes: Unicentro (local 222, C.C. Unicentro) y Chipichape (local 9-111) | Preguntar sede temprano y proponer horarios de **esa** sede |
| Precio sin contexto de valor | Se da el precio y el anticipo sin explicar qué incluye | Antes de pedir el anticipo, 1 línea de qué incluye la limpieza (sin promesas de resultado) |

**Seguimiento (secuencia sugerida, todo dentro de 24 h salvo la plantilla):**
1. +30–60 min sin respuesta: mensaje corto con 2 horarios concretos.
2. +3–4 h: recordatorio del bono vigente hasta 31 oct + pregunta de sede.
3. +22 h: ya existe; mantener.
4. Fuera de ventana: plantilla `retomar_cita_limpieza` (rinde 0/9; revisar copy o probar otra).

---

## 5. Eventos de conversión (CAPI) — checklist de verificación

Estado: Juan ya conectó el token. Todavía **no se ha generado un pago**, así que aún no sabemos si el evento sale bien. Spec completa en el doc del proyecto `evento-anticipo-capi-spec`.

Datos: dataset `38756680020642307` · WABA `1997545614294706`.

Verificar, en este orden:

1. Al recibir el **primer mensaje** de un chat que viene de un anuncio, guardar `ctwa_clid` y `source_id` del `referral` del webhook (sin esto no hay forma de atribuir el pago al anuncio).
2. Al confirmarse el pago del anticipo (webhook de Bold o confirmación manual de transferencia), enviar evento **Purchase** a la Conversions API for Business Messaging con `messaging_channel: whatsapp`, `ctwa_clid`, valor pagado y `currency: COP`.
3. `event_id` único por pago (evitar duplicados si Bold reintenta el webhook).
4. Probar con un evento de prueba en **Events Manager → dataset → Probar eventos** (Andrés puede pasar el `test_event_code`; el token lo genera el equipo de Juan/cliente, nunca VIRAND). **Quitar `test_event_code` en producción.**
5. Confirmar en **Diagnóstico** que no hay errores de parámetros y que el evento aparece atribuido al anuncio.
6. Si el pago es por transferencia (sin Bold), definir quién confirma y cómo se dispara el evento (botón en el panel "Anticipo confirmado" → dispara Purchase).
7. Mostrar en el panel el estado del evento (enviado / error / sin ctwa_clid) para que Andrés pueda auditar.

---

## 6. Diagnóstico pendiente: chats que no llegan al panel

Meta reporta ~32 conversaciones; el panel muestra 24 chats. Hay una brecha de unos 8 que no sabemos explicar. Pedimos a Juan:

- Revisar logs del webhook entre las 06:00 y las 13:00 del 19 oct (la madrugada y la mañana del cambio de rutas).
- Revisar `pm:wa:rejected` y cualquier descarte por filtro (mensajes sin texto, tipos no soportados, chats sin `referral`).
- Confirmar que los mensajes de tipo imagen/audio/sticker/ubicación **crean** el chat en el panel aunque el bot no pueda procesarlos.
- Confirmar que el webhook responde 200 rápido (Meta reintenta y puede desactivar la suscripción si falla).

---

## Resumen de prioridades

1. Efectivo → no perder el lead (sección 1).
2. Anticipo fijo y descontable (sección 2) — confirmar monto con Johanna antes de activar.
3. Primer mensaje con una sola pregunta + horarios concretos + seguimientos en 24 h (sección 4).
4. Verificar CAPI con el primer pago (sección 5).
5. Diagnóstico de chats perdidos (sección 6).
6. 2×1: **sin cambios** (sección 3).

---

## Estado en Gema (20 oct 2026)

| # | Pedido | Estado | Detalle |
|---|---|---|---|
| 1 | Pago en efectivo | ✅ Hecho | La primera vez que lo menciona, Gema le dice que el resto lo paga en la sede en efectivo o como prefiera, y que el anticipo separa el cupo y se descuenta del valor. Si insiste, le dice que lo confirma con la sede (y cuándo responde, según el horario de asesoras) y pasa el chat a Johanna con el motivo "Pago en efectivo". Si en **30 minutos de horario de asesoras** nadie del equipo le escribe, Gema retoma con el anticipo y dos horas concretas, y vuelve a atender el chat (decisión de Premier). El chat queda marcado con la objeción "Quiere pagar en efectivo", visible en el panel. Prueba con el modelo: 5/5 reencuadran la primera vez, 5/5 pasan a Johanna cuando insiste. |
| 1 | Excepciones sin anticipo y política de reprogramación | ⏳ Pendiente de Johanna | Hoy Gema reprograma conservando el pago y una persona gestiona los reembolsos. |
| 2 | Anticipo fijo | ✅ Listo, **apagado** | Campo "Anticipo fijo ($)" en Configuración del panel. En 0 sigue el 50 %. Al escribir 50000 aplica a todas las citas, sin pasar del precio, y una pareja paga un solo anticipo. Prueba simulada con $50.000: 5/5 dicen "$50.000 ahora + $80.000 en la sede, total $130.000". |
| 2 | "Se descuenta del valor" y la cuenta | ✅ Hecho (ya activo) | En el catálogo que ve Gema, en el mensaje de la reserva que compone el servidor ("anticipo de $65.000, que se descuenta del valor de tu limpieza: $65.000 ahora y $65.000 en la sede, total $130.000") y en las respuestas sobre el anticipo. |
| 2 | Plantillas con el monto | ✅ No hace falta | Ninguna plantilla aprobada menciona el monto: no hay que reenviar a aprobación. |
| 2 | Purchase con el valor pagado | ✅ Ya era así | `value` = anticipo o pago completo realmente pagado. |
| 3 | 2×1 | ✅ Sin cambios | |
| 4 | Una sola pregunta | ✅ Hecho | Si la respuesta trae una pregunta genérica ("te gustaría agendar?") y otra concreta, el servidor deja la concreta; con dos, "hola, cómo estás?" queda como "hola". Prueba: 10/10 primeras respuestas con una sola pregunta. |
| 4 | Seguimientos dentro de 24 h | ✅ Hecho | +45 min: dos horas concretas libres de la sede del cliente (o la primera de cada sede). +3 h: el 2×1 vigente del servicio que le interesa y la pregunta de sede. Siguen el de 22 h y la plantilla de 24–48 h. Los "cupos de la semana" no se usan hasta que Johanna confirme que son reales. |
| 4 | Imagen, audio y enlaces | ✅ Hecho | Las imágenes y notas de voz ya se analizan y transcriben. Con video, documento o enlace, Gema dice en una frase que no lo puede abrir y retoma la pregunta pendiente. |
| 4 | Sede temprano y qué incluye | ✅ Hecho | Ya preguntaba la sede en el primer mensaje; antes de pedir el anticipo dice en una frase qué incluye la limpieza. |
| 5 | `ctwa_clid` y `source_id` | ✅ Ya estaba | Se guardan con el primer mensaje del anuncio. |
| 5 | Purchase y `event_id` único | ✅ Ya estaba | Por Bold al confirmar y por transferencia cuando la asesora confirma la cita en la agenda. |
| 5 | **Dataset** | ⚠️ **Cambió** | El dataset 38756680020642307 no estaba vinculado a la cuenta de WhatsApp (WABA 1997545614294706): Meta rechazó el primer evento real (error 2804132). Se obtuvo el vinculado con `POST /{WABA}/dataset`: **1636157554637715**. Gema ya envía ahí, y el evento que había fallado se reenvió (`events_received: 1`). **Andrés debe mirar este dataset en el Administrador de eventos.** |
| 5 | Evento de cita | ⚠️ Cambió | Meta no acepta `Schedule` en mensajería (error 2804066); la cita va como **`LeadSubmitted`**. |
| 5 | Estado del evento en el panel | ✅ Hecho | En el panel, "Conversión Meta" muestra si se envió, el error, o "No aplica: no llegó desde un anuncio". |
| 5 | Prueba con `test_event_code` | ⏳ Opcional | Si Andrés pasa el código, se configura `META_CAPI_TEST_CODE` en Vercel. El evento real ya se comprobó. |
| 6 | Chats que no llegan al panel | ✅ **Encontrado y corregido** | Los clientes que usan **nombre de usuario de WhatsApp** (número oculto) llegan sin `from`, con un identificador tipo `CO.1349…`. El webhook fallaba con esos mensajes: hubo 150 entregas rechazadas desde el 18 oct, y esos clientes no recibieron respuesta ni aparecieron en el panel. Ahora se guardan y se les responde (a ese identificador, por `recipient`). Meta reintenta las entregas fallidas: los pendientes deberían aparecer en el panel, sin respuesta automática por antigüedad, para que los atienda una asesora. |
| 6 | Imagen, audio, sticker, ubicación | ✅ Ya estaba | Todos crean o actualizan el chat; los stickers, reacciones y ubicaciones se guardan sin respuesta. |
| 6 | 200 rápido | ✅ Ya estaba | El webhook responde de inmediato; los archivos y la IA se procesan después. |
