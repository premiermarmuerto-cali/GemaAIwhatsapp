# Conoce a Gema

**Manual de Premier Mar Muerto Cali · BORRADOR v1 · octubre 2026**

Gema es la asesora virtual de Premier en WhatsApp: contesta las 24 horas, informa los servicios y precios, agenda citas en las dos sedes y cobra la reserva con un link de pago de Bold. Cuando algo necesita a una persona, se lo pasa a una asesora.

Este manual tiene cuatro partes: **1)** cuánto cuesta mantenerla, **2)** cómo trabaja, **3)** qué hace el operador cada día y **4)** qué hay que cuidar para que no se caiga.

---

## 1. Cuánto cuesta que Gema funcione

> **Cómo leer esta sección.** Los precios salen de las páginas oficiales de cada proveedor y de comparativas de terceros consultadas en octubre 2026. Los proveedores cambian tarifas, así que **verifica cada cifra en el enlace de la última columna antes de presupuestar.** Los montos en dólares (USD) se pagan en pesos a la tasa del día. Las cifras de consumo son **estimaciones** mías a partir del tamaño real de Gema, no mediciones de un mes completo.

### 1.1 Resumen mensual

| Servicio | Para qué sirve | Costo | ¿Fijo o variable? |
|---|---|---|---|
| **Vercel (Pro)** | Aloja a Gema y el panel en internet | **USD 20 / mes** | Fijo |
| **OpenAI** | El "cerebro" que redacta las respuestas, lee imágenes y transcribe audios | **≈ USD 1 por cada 1.000 respuestas** (ver 1.3) | Variable |
| **Upstash Redis** | La base de datos: chats, citas, configuración | **USD 0 a ≈ 5 / mes** (ver 1.4) | Casi fijo |
| **Meta / WhatsApp Cloud API** | El número de WhatsApp de Gema | **USD 0 por las respuestas de Gema** dentro de la ventana de 24 h. Plantillas: **USD 0,0125 cada mensaje de marketing** y **USD 0,0008 cada recordatorio** (ver 1.5) | Variable |
| **Programador de tareas** | Dispara los recordatorios y seguimientos cada 15 min | **USD 0**: incluido en Vercel Pro, o gratis con cron-job.org | Fijo |
| **Bold** | Cobrar la reserva | **Sin mensualidad;** comisión por cada pago (ver 1.6) | Variable, la paga Premier por venta |
| Dominio propio *(opcional)* | Una dirección tipo `gema.premier.co` en vez de `premier-agente.vercel.app` | ≈ USD 15 / año | Fijo |

**Piso mensual realista: ≈ USD 21 a 25 al mes** (≈ COP 85.000–100.000 a una tasa ilustrativa de 4.000), sin contar la publicidad en Meta ni las comisiones de Bold, que dependen de las ventas. Las plantillas de WhatsApp suman poco: ≈ USD 4 por cada 500 enviadas (ver 1.5).

### 1.2 Vercel — el servidor  ⚠️ **decisión pendiente**

- Hoy Gema corre en el plan **Hobby (gratis)**. Ese plan es **solo para uso personal y no comercial**: según las condiciones de Vercel, un negocio que cobra a clientes debe estar en **Pro**. Para un cliente real recomiendo **pasar a Pro: USD 20 al mes** (incluye 1 usuario que despliega y USD 20 de consumo).
- Pro también permite **tareas programadas cada pocos minutos** (Vercel Cron), que son las que disparan los recordatorios y seguimientos. En Hobby solo corren una vez al día, así que mientras siga en Hobby hay que usar un programador externo gratuito (cron-job.org, ver 4.1).
- Beneficio adicional: en Hobby la plataforma recorta en silencio el tiempo que tiene Gema para responder; ya lo mitigamos en el código, pero Pro da más margen.
- Fuentes de las cifras: [Vercel Pricing 2026 (modelence)](https://modelence.com/compare/vercel-pricing), [Vercel pricing 2026 (deploycloud)](https://deploycloud-shopify.devcloudsoftware.com/blog/vercel-pricing). **Verificar en <https://vercel.com/pricing>.**

### 1.3 OpenAI — el cerebro

- Modelo en uso: **gpt-4o-mini**. Tarifa: **USD 0,15 por millón de tokens de entrada y USD 0,60 por millón de salida** ([OpenAI](https://developers.openai.com/api/docs/models/gpt-4o-mini)).
- Medí el prompt real de Gema: **≈ 5.200 tokens** por respuesta (instrucciones, catálogo, agenda de 14 días) más ≈ 1.000 de historial, y ≈ 200 de respuesta. Eso es **≈ USD 0,001 por respuesta** (menos si OpenAI reutiliza el prompt en caché).
- Una conversación completa de 10 respuestas cuesta **≈ USD 0,01 (≈ COP 40)**.

| Volumen al mes | Conversaciones | Costo OpenAI aprox. |
|---|---|---|
| Pequeño | 300 | USD 3 |
| Medio | 1.000 | USD 10 |
| Alto (campaña fuerte) | 3.000 | USD 30 |

- Las notas de voz y las imágenes suman un poco: la transcripción de audio y la lectura de imágenes se cobran aparte, pero a fracciones de centavo por mensaje.
- **Tope de seguridad ya incluido:** Gema no responde más de 15 mensajes por cliente cada 10 minutos ni más de 300 respuestas por hora en total; si se supera, pasa el chat a una persona. Esto evita una factura inesperada si alguien intenta abusar. Se ajusta con las variables `AI_MAX_REPLIES_PER_PHONE` y `AI_MAX_REPLIES_PER_HOUR`.
- **Recomendación:** en <https://platform.openai.com> activar **recarga manual (prepago) con un tope mensual**, para que nunca se cobre más de lo previsto.

### 1.4 Upstash Redis — la base de datos

- Plan gratis: **500.000 comandos al mes**, 256 MB, 10 GB de tráfico. Pago por uso: **USD 0,20 por cada 100.000 comandos** adicionales ([Upstash](https://upstash.com/pricing/redis)).
- Lo que más consume **no son los clientes sino el panel abierto**: la consola consulta la base de datos cada 4 y 8 segundos mientras la pestaña está visible. Una jornada con el panel abierto puede gastar decenas de miles de comandos; **un mes con el panel abierto todos los días puede pasar el plan gratis** (estimación mía: del orden de 1 millón de comandos, ≈ USD 2).
- **Recomendación:** crear la base en el plan de pago por uso con un **tope de presupuesto mensual (p. ej. USD 10)**. Es mejor eso que arriesgar que se agote el plan gratis y Gema deje de responder.
- Datos: son pequeños (chats, citas, configuración); no se acerca al límite de 256 MB por años.

### 1.5 Meta / WhatsApp — el número

- **Las respuestas de Gema a quien escribe primero no cuestan** mientras el cliente haya escrito en las últimas 24 horas (cada mensaje suyo reinicia la ventana).
- **Sí cuestan** los mensajes que Gema envía con plantilla cuando la ventana de 24 h ya se cerró. Meta cobra **por cada plantilla entregada**, según su categoría. Tarifas de Colombia desde el 1 de octubre de 2026 (comparativas de terceros que coinciden entre sí; la tarifa oficial está en <https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing>):

  | Plantilla de Gema | Categoría | Precio por mensaje entregado |
  |---|---|---|
  | `retomar_cita_limpieza`, `anticipo_pendiente`, `ultimos_dias_bono` | Marketing | **USD 0,0125** (≈ COP 50) |
  | `recordatorio_cita` | Utilidad | **USD 0,0008** (≈ COP 3) |

  Ejemplo: 300 plantillas de marketing y 200 recordatorios al mes son ≈ **USD 3,90** (USD 3,75 + 0,16).
- **Lo que hace Gema para no gastar de más:** si la clienta escribió en las últimas 24 h, el recordatorio y los seguimientos van como **texto libre, que es gratis**; la plantilla solo se usa con la ventana cerrada. Además envía máximo **una plantilla de marketing por persona cada 3 días** y nunca a quien tocó **"Ahora no"**.
- **Cuidado con la calidad del número:** si mucha gente bloquea o reporta las plantillas de marketing, Meta baja la calificación del número y limita cuántas puede enviar al día. Por eso los topes de arriba.
- La **publicidad** que lleva clientes a WhatsApp tiene su propio presupuesto.
- Los anuncios "Click to WhatsApp" tienen su propio presupuesto de publicidad, **que no está incluido en nada de lo anterior**.
- Para que Gema funcione hace falta una **cuenta de Meta Business verificada**; verificarla no tiene costo, pero sí requiere documentos de la empresa.

### 1.6 Bold — el cobro

- No hay mensualidad por usar el link de pagos de la API. **Bold descuenta una comisión de cada pago** y la deposita neta a Premier.
- Una comparativa de terceros indica, como referencia: **tarjeta nacional 2,80 % + COP 500 + IVA; tarjeta internacional 3,50 %; PSE y Nequi 1,79 %** ([guiadesoftware.com](https://www.guiadesoftware.com/blog/mejor-pasarela-pago-colombia)). Ejemplo: un anticipo de $85.000 con tarjeta nacional deja una comisión de ≈ $3.400. **Estas cifras pueden estar desactualizadas: la tarifa real es la del contrato de Premier con Bold; confírmala con su ejecutivo.**
- Un detalle importante: **Bold no permite anular un link ya generado.** Cada reserva crea un link que vence solo cuando termina el apartado (120 minutos).

### 1.7 Lo que NO está en estas cifras

- **El mantenimiento del sistema** (cambios, correcciones, soporte): no está incluido; es trabajo del desarrollador aparte.
- **Cambios de precio** de los proveedores.
- **Cualquier operador humano** que atienda el panel y las escalaciones.

---

## 2. Cómo trabaja Gema

### 2.1 Lo que hace

1. **Responde siempre,** a cualquier hora, incluso con la clínica cerrada.
2. **Primera respuesta directa:** quien llega desde un anuncio o pregunta por un servicio recibe de inmediato en qué consiste, su precio y la promoción vigente, y la pregunta "¿en qué sede te queda mejor?". No lo interroga primero.
3. **Agenda de verdad:** ve la disponibilidad real de 14 días en las dos sedes y solo ofrece horas libres. Aparta la cabina en el instante en que el cliente acepta.
4. **Cobra la reserva:** pregunta si prefiere pagar el **anticipo (50 %)** o la **sesión completa**. Al apartar la cita le ofrece los dos medios y espera a que elija:
   - **Link de Bold** (PSE, tarjeta débito o crédito, Nequi o Daviplata): un link único por cita. Cuando Bold confirma el pago, la cita queda confirmada sola y el cliente recibe el aviso por WhatsApp, sin intervención del operador.
   - **Transferencia directa** a Nequi 3114644721, Daviplata 3214040436 o la cuenta de ahorros Bancolombia 91232333868: el cliente manda la captura del comprobante y el chat pasa a una asesora para validarlo.

   Si el cliente ya dijo cómo quiere pagar ("por Nequi", "con tarjeta"), Gema le manda ese medio directamente. El link de Bold solo se crea cuando el cliente lo elige, así no quedan links abiertos que nadie usa.
5. **Parejas (2x1):** agenda dos personas a la misma hora, cada una en su cabina, con el mismo servicio.
6. **Entiende** notas de voz (las transcribe), fotos y capturas (las lee), y contesta en el idioma del cliente.
7. **Escribe como una persona, no como un bot:** mensajes cortos, informales, a veces en 2 o 3 mensajes seguidos con una pausa de un segundo entre uno y otro, sin signos de apertura (¿ ¡), sin frases de call center ("con gusto te ayudo", "quedo atenta") y sin emojis. Si le preguntan si es un bot, responde que es la asistente virtual de Premier y ofrece pasar con una asesora. El link de pago y las cuentas siempre van completos en un solo mensaje. Estas reglas están en el prompt y además el servidor las refuerza, porque el modelo a veces se desvía.
7. **Pasa a una persona** cuando corresponde (ver 2.6).
8. **Cambia, cancela y confirma citas** (ver 2.3) y **escribe sola** recordatorios y seguimientos (ver 2.4).

### 2.2 Reglas de negocio vigentes (octubre 2026)

| Tema | Regla |
|---|---|
| Sedes | Unicentro y Chipichape, **2 cabinas cada una** |
| Horario de citas | Lunes–jueves: primera cita 10:00 a.m., **última 6:30 p.m.** · Viernes y sábado: 10:00 a.m. a **8:00 p.m.** · Domingo: 10:00 a.m. a **5:00 p.m.** *(son horas de inicio; la sesión puede terminar después)* |
| Horario de asesoras | Lunes a sábado 10:00 a.m.–6:00 p.m. · Domingo no hay atención humana |
| Anticipo | 50 % del valor, o el pago completo si el cliente lo prefiere |
| Apartado | El horario se guarda **120 minutos** mientras se paga; si no, se libera solo |
| Anticipación mínima | 2 horas |
| Catálogo | Peeling y Hidratación $130.000 (30 min) · Hidratación y Pigmentación $170.000 · Disminución de Líneas de Expresión $200.000 · Hidratación Profunda con Dispositivo Médico $250.000 (45 min cada una). Las duraciones son estándar y aproximadas |
| **2x1** | **Solo en dos servicios.** Dos personas, mismo servicio, mismo día y misma hora, pagan **una** sesión. **Peeling y Hidratación:** sesiones **hasta el 31 de octubre de 2026**. **Líneas de Expresión:** sin fecha límite por ahora. **Pigmentación e Hidratación Profunda:** no incluyen 2x1. Sin 2x1 (o después de la fecha), una pareja agenda y paga dos sesiones |
| Pagos | Bold por defecto (tarjeta, PSE, Nequi; clientes del exterior con tarjeta de crédito, en pesos). También transferencia directa a Bancolombia, Nequi o Daviplata |

> **Importante:** estas reglas se cambian en el panel (⚙ Configuración), no hay que tocar código. Pero un cambio mal hecho cambia lo que Gema promete.

### 2.3 Cambios, cancelaciones y confirmación de asistencia

- **Reprogramar:** si la clienta quiere otro día, hora o sede, Gema le ofrece horas libres y mueve la cita. Es **la misma cita**: se conserva lo que ya pagó (anticipo o sesión completa) y el link de Bold.
- **Cancelar:** si dice que no podrá asistir, Gema primero ofrece cambiar la fecha (su pago se conserva). Si igual quiere cancelar, Gema cancela la cita y **libera el cupo en la agenda**. Si la cita **ya estaba pagada**, el chat pasa a una asesora como **"Reembolso"**: el dinero lo devuelve siempre una persona, nunca Gema.
- **Confirmar asistencia:** cuando la clienta responde "Confirmo mi cita" (botón del recordatorio o mensaje), la cita queda con **asistencia confirmada**. Eso es distinto de *pagada* y se ve en la ficha de la cita.
- **Pareja (2x1):** cada sesión se agenda con el **nombre completo de quien se la hace**. Gema no reserva hasta tener los dos nombres. Solo se guardan los nombres y el número de WhatsApp: ni cédula, ni correo, ni otros datos.

### 2.4 Mensajes automáticos

Gema también escribe sola, sin que la clienta haya escrito. Un programador la despierta cada 15 minutos.

| Mensaje | Cuándo | Cómo |
|---|---|---|
| Aviso de pago pendiente | ~30 min antes de que se libere un horario apartado sin pago | Texto libre (gratis) |
| Recordatorio de la cita | 24 h antes de cada cita **pagada** | Texto libre si la clienta escribió en las últimas 24 h; si no, plantilla `recordatorio_cita` |
| Recordatorio del día | 2–3 h antes, solo si confirmó asistencia | Texto libre |
| Seguimiento | ~22 h después de su último mensaje, si no respondió y no tiene cita | Texto libre |
| Retomar la cita | Más de 24 h sin escribir y sin cita (hasta 7 días) | Plantilla `retomar_cita_limpieza` |
| Anticipo pendiente | El horario se liberó sin pago hace más de 24 h y la fecha aún no pasa | Plantilla `anticipo_pendiente`. Si toca **"Reenviar el link"**, Gema vuelve a apartar el mismo horario (si sigue libre) y le manda un link nuevo |
| Últimos días del 2x1 | 2–3 días antes de que venza una promoción, a quien escribió y no agendó | Plantilla `ultimos_dias_bono`. La oferta se arma sola desde la configuración del 2x1 |

**Reglas de cortesía, ya programadas:**
- Solo se envían entre **8:00 a.m. y 9:00 p.m.**
- Nunca a un chat que está atendiendo una persona (Gema en pausa o con alerta de asesora).
- Cada mensaje se envía **una sola vez** y queda registrado en la ficha del chat ("Automáticos").
- Máximo 25 envíos por corrida y una plantilla de marketing por persona cada 3 días.
- Si la clienta toca **"Ahora no"**, no recibe más plantillas de marketing; los recordatorios de su cita sí le llegan.

**Interruptores** (variables en Vercel): `AUTOMATIONS=off` apaga todo lo automático; `WHATSAPP_TEMPLATES=on` activa las plantillas. Este último **debe quedar en off hasta que las plantillas estén aprobadas en Meta** y las imágenes subidas.

### 2.5 Cómo es una reserva por dentro

1. El cliente acepta día, hora y sede, y da su nombre.
2. Gema escribe el mensaje y añade una **marca invisible** para el cliente (por ejemplo `[[RESERVA: …]]`). Gema nunca llama al sistema directamente.
3. El **servidor** lee la marca, aparta la cabina, calcula el precio y el anticipo, crea el link de Bold y **pega él mismo** el monto y el link en el mensaje. Así Gema no puede inventar precios ni cuentas bancarias.
4. Si el horario se ocupó justo antes, ofrece otras horas automáticamente.
5. Al llegar el pago, Bold avisa al servidor (webhook) y la cita pasa a **Confirmada**.

### 2.6 Cuándo pasa el chat a una persona

Gema escala (el chat aparece marcado en la bandeja) cuando:
- el cliente pide hablar con una persona;
- **envía el comprobante de una transferencia** (aparece como *Pago por validar*);
- **cancela una cita ya pagada** (aparece como *Reembolso*) o pregunta algo sobre su dinero;
- tiene un reclamo o describe una condición médica;
- pregunta algo que Gema no sabe (precio no configurado, condiciones de promoción que no están escritas);
- algo falla (Bold no generó el link, WhatsApp rechazó el mensaje, se superó el tope de respuestas).

Siempre le dice al cliente **cuándo** lo atiende una asesora, según el horario real (lunes a sábado 10–6; los domingos, desde el lunes a las 10:00 a.m.).

---

## 3. Lo que hace el operador

### 3.1 El panel

El panel (`https://premier-agente.vercel.app`, con la clave de administrador) tiene dos zonas:

- **Consola:** bandeja de chats con filtros **Todas · IA · Humano · Agendados**. Cada chat muestra quién lo atiende: *Gema (IA)* o *Operador*, y una etiqueta roja si necesita una persona. Al abrir un chat se ve la ficha del cliente, la cita y si llegó **desde un anuncio** ("Desde anuncio").
- **Agenda:** semana por sede. Cada cita es un bloque; una **pareja ocupa dos columnas**. Se puede crear una cita a mano (queda **confirmada**, sin anticipo), bloquear un horario (almuerzo, capacitación) y cerrar un día completo (festivo).
- **⚙ Configuración:** voz de Gema, catálogo y precios, horarios, sedes, cabinas, cobro, promoción, 2x1 por servicio y preguntas frecuentes.

### 3.2 Rutina diaria

**Al abrir (10:00 a.m.)**
1. Abrir la consola y filtrar **Humano** / buscar chats con etiqueta roja: son los que Gema dejó esperando durante la noche o el domingo.
2. Atender primero los **Pago por validar**, después los **Reembolso** (devolver el dinero desde Bold o por transferencia y avisarle a la clienta) y luego los **Requiere asesor**.
3. Revisar en la **Agenda** las citas del día: la ficha dice si la clienta **confirmó asistencia** con el recordatorio.

**Durante el día**
4. Para responder a un cliente basta con **escribir en el chat**: eso pausa a Gema en ese chat automáticamente ("Control humano").
5. Cuando termines, pulsa **Devolver a Gema** para que retome. Si no lo haces, ese cliente queda sin respuesta automática **y tampoco recibe los recordatorios ni seguimientos automáticos**.

**Al cerrar (6:00 p.m.)**
6. No dejar chats en rojo sin responder: desde las 6:00 p.m. nadie del equipo los verá hasta el día siguiente (domingo, hasta el lunes).

**En la ficha de cada chat (columna derecha de la consola)** se ve el anuncio por el que llegó, si tocó "Ahora no" (no recibe marketing) y qué mensajes automáticos se le enviaron y cuándo.

### 3.3 Cómo validar una transferencia

1. El cliente transfiere a Bancolombia / Nequi / Daviplata y envía la captura. El chat aparece como **Pago por validar** y el horario queda apartado (se amplía mientras revisas).
2. **Revisa el dinero en tu app bancaria**, no solo la captura (una imagen no prueba el pago).
3. Si llegó y el monto es correcto: en la **Agenda**, abre la cita y confírmala. Avísale al cliente por el chat.
4. Si no llegó o el monto no coincide: respóndele y, si no paga, el horario se libera solo al vencer el apartado.

### 3.4 Pagos con Bold

- Son automáticos: **no tienes que hacer nada**. Verás la cita en *Confirmada* y una nota de "Pago recibido".
- **Revisa aparte** si te llega una alerta de "pago sobre cita cancelada" o "monto menor": significa que alguien pagó un horario que ya no existe o pagó de menos; hay que reagendar o devolver el dinero **desde el portal de Bold**.
- Un cliente puede pagar el link dos veces; Bold no lo impide. Verifica en el portal de Bold si dudas.

### 3.5 Cambios que SÍ puede hacer el operador en Configuración

Precios, horarios, texto de la promoción, 2x1 por servicio (casilla + fecha), datos de transferencia, preguntas frecuentes, días cerrados.

### 3.6 Lo que NO debe hacer

- ❌ **Abrir el panel con una versión vieja guardada en otra pestaña y guardar:** puede borrar la promoción. Si el panel parece raro, recarga (Ctrl + F5) antes de guardar.
- ❌ Cambiar el **nombre de un servicio** sin avisar: la voz de Gema y el catálogo deben llamarse igual.
- ❌ Compartir la clave del panel.
- ❌ Prometerle a un cliente algo que Gema no prometió (una fecha de promoción, un descuento).

### 3.7 Lo que el operador debe saber del 2x1

- Solo aplica a **Peeling y Hidratación** y a **Líneas de Expresión**. Pigmentación e Hidratación Profunda no tienen 2x1: si una pareja pregunta por ellas, Gema se lo dice y agenda dos sesiones.
- Es **por sesión, no por reserva:** el 31 de octubre vence la promoción del Peeling para sesiones hasta esa fecha, aunque se reserve antes. La de Líneas de Expresión no tiene fecha.
- La pareja va **a la misma hora, en cabinas distintas.** Si una sede no tiene dos cabinas libres a esa hora, Gema ofrece otra hora u otra sede.
- Cuando el 2x1 de un servicio vence, el sistema deja de ofrecerlo solo y cobra dos sesiones a las parejas. Para apagarlo antes, quita la casilla del servicio en Configuración.

---

## 4. Qué hay que cuidar para sostener el sistema

### 4.1 Las llaves y cuentas (lo que NUNCA debe perderse)

Todas están guardadas como **variables de entorno** en Vercel (*Settings → Environment Variables*) y en el archivo local `.env.local` del desarrollador. **Nunca se publican en GitHub.**

| Variable | Qué es | Dónde se genera | ¿Vence? |
|---|---|---|---|
| `OPENAI_API_KEY` | Llave de OpenAI | platform.openai.com → API keys | No, pero se revoca si se filtra |
| `WHATSAPP_ACCESS_TOKEN` | Permiso para enviar mensajes por WhatsApp | Meta Business → Usuarios del sistema | ⚠️ **Debe ser un token permanente.** Los temporales caducan en 24 h y Gema deja de contestar |
| `WHATSAPP_PHONE_NUMBER_ID` | Identifica el número de Gema | Meta for Developers → WhatsApp → API Setup | No |
| `WHATSAPP_APP_SECRET` | Firma que prueba que los mensajes vienen de Meta | Meta for Developers → App → Configuración básica | No |
| `WHATSAPP_VERIFY_TOKEN` | Contraseña para conectar el webhook con Meta | La escoge el desarrollador | No |
| `BOLD_API_KEY` | Llave de identidad de Bold (crea los links) | Portal Bold → Integraciones | No |
| `BOLD_WEBHOOK_SECRET` | Llave secreta con que Bold firma los avisos de pago | Portal Bold → Integraciones | No |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Acceso a la base de datos | console.upstash.com | No |
| `ADMIN_PASSWORD` / `AUTH_SECRET` | Clave de la consola y secreto de sesión | La escoge el desarrollador | Cambiarla si alguien sale del equipo |
| `OPENAI_MODEL` | Modelo (`gpt-4o-mini`) | — | — |
| `CRON_SECRET` | Clave que debe enviar el programador para disparar los mensajes automáticos | La escoge el desarrollador (texto largo y aleatorio) | No |
| `AUTOMATIONS` | `on` / `off`: interruptor general de mensajes automáticos | — | — |
| `WHATSAPP_TEMPLATES` | `on` / `off`: envío de plantillas (se cobran) | — | Dejar en `off` hasta que estén aprobadas |
| `PUBLIC_APP_URL` | Dirección pública del panel; de ahí Meta descarga las imágenes de las plantillas | — | Cambiarla si se usa un dominio propio |

> Si cambias una variable en Vercel, **hay que volver a desplegar** (Deployments → Redeploy) para que Gema la tome.

**El programador de mensajes automáticos.** Algo tiene que llamar a `https://premier-agente.vercel.app/api/cron` cada 15 minutos con el encabezado `Authorization: Bearer <CRON_SECRET>`. Dos opciones:
- **Con Vercel Pro:** se configura como Vercel Cron, dentro del mismo proyecto.
- **Mientras siga en Hobby:** una cuenta gratuita de **cron-job.org** con esa dirección, cada 15 minutos y ese encabezado.

Si el programador se detiene, Gema **sigue respondiendo** con normalidad. Lo único que se pierde son los recordatorios, seguimientos y plantillas.

**Las plantillas en Meta.** Están en WhatsApp Manager → Plantillas de mensajes, en idioma Spanish (COL) `es_CO`:
- No se les cambia el nombre ni las variables sin avisar al desarrollador.
- Si Meta rechaza o pausa una, Gema la intenta como máximo una vez al día y el error queda en los registros de Vercel.
- Las imágenes de encabezado están en la carpeta `public/plantillas/` del proyecto.

### 4.2 Accesos: dónde se entra a cada sistema

> 🔒 **Regla de oro: en este documento NO se escriben contraseñas.** El manual se guarda en el repositorio de GitHub y se comparte; si una clave queda aquí, queda expuesta. Aquí solo van la dirección, el correo de la cuenta y **dónde está guardada la clave** (un gestor de contraseñas como Bitwarden o 1Password, con acceso para al menos **dos personas** de Premier). Completa las celdas en blanco con tu información.

| Sistema | Para qué lo usas | Dirección | Cómo se entra | Cuenta (correo) | Clave guardada en | Responsable |
|---|---|---|---|---|---|---|
| **Panel de Gema** (consola y agenda) | El día a día del operador | <https://premier-agente.vercel.app> | Clave de administrador (la variable `ADMIN_PASSWORD`) | *(no usa correo)* | _completar_ | _completar_ |
| **Vercel** | El servidor donde corre Gema; variables de entorno; redeploy | <https://vercel.com/login> | Correo + clave (o inicio con GitHub) | _completar_ | _completar_ | _completar_ |
| **GitHub** | El código de Gema | <https://github.com/premiermarmuerto-cali/GemaAIwhatsapp> | Correo/usuario + clave + verificación en 2 pasos | _completar_ | _completar_ | _completar_ |
| **Meta Business / for Developers** | El número de WhatsApp, el webhook, los tokens | <https://business.facebook.com> y <https://developers.facebook.com> | Facebook personal del administrador de la cuenta de Meta Business | _completar_ | _completar_ | _completar_ |
| **OpenAI Platform** | Llave de la IA, saldo y consumo | <https://platform.openai.com> | Correo + clave | _completar_ | _completar_ | _completar_ |
| **Upstash** | La base de datos y su consumo | <https://console.upstash.com> | Correo + clave (o inicio con Google/GitHub) | _completar_ | _completar_ | _completar_ |
| **Bold** | Pagos recibidos, comisiones, devoluciones y llaves de integración | Portal de comercios de Bold (la dirección que Bold le dio a Premier) | Correo + clave | _completar_ | _completar_ | _completar_ |
| **Cuentas bancarias de transferencia** | Validar que llegó el dinero (Bancolombia, Nequi, Daviplata) | Apps de cada banco | Las de Premier | — | Cada titular | _completar_ |

**Buenas prácticas con estos accesos**

1. **Cuentas a nombre de Premier**, no del desarrollador ni de una persona que pueda irse. Un error típico es que Vercel, Meta u OpenAI queden en el correo personal de quien montó el sistema.
2. **Dos personas con acceso** a cada sistema (el dueño y una persona de confianza). Si solo una persona tiene la clave y no está, nadie puede arreglar nada.
3. **Verificación en dos pasos** activada en GitHub, Vercel, Meta y Bold. Estos cuatro permiten cobrar, enviar mensajes y cambiar el código; son los más delicados.
4. **Un solo correo "dueño"** de la cuenta de Meta Business (recomendado: uno de la empresa, no personal) para recibir los avisos de verificación y facturación.
5. **Cuando alguien sale del equipo:** cambiar la clave del panel (`ADMIN_PASSWORD`), quitarlo de Vercel, GitHub, Meta y Bold, y rotar las llaves que conocía (sección 4.1).
6. **Qué hacer si se pierde una clave:** cada sistema tiene "olvidé mi contraseña" al correo de la cuenta; por eso es importante saber **cuál correo** es el de cada cuenta.

### 4.3 Conexiones que pueden romperse (y cómo se nota)

| Conexión | Si se rompe… | Cómo se nota |
|---|---|---|
| **Webhook de WhatsApp** (Meta → Gema) | Gema deja de recibir mensajes | Nadie responde y no entra nada a la consola |
| **Token de WhatsApp** | Gema recibe pero no puede contestar | Chats en rojo con "WhatsApp rechazó el envío" |
| **Webhook de Bold** | Se cobra pero la cita no se confirma sola | El cliente pagó y su cita sigue "Apartada" |
| **OpenAI sin saldo** | Gema no puede redactar | Chats en rojo "Gema no pudo generar una respuesta" |
| **Upstash agotado** | Todo falla (chats, citas, panel) | La consola no carga o da errores |
| **Vercel caído** | Panel y Gema sin servicio | La URL no abre |
| **Programador detenido** (Vercel Cron o cron-job.org) | No salen recordatorios, seguimientos ni plantillas; Gema sigue respondiendo | La ficha de los chats deja de mostrar "Automáticos" nuevos |
| **Plantilla rechazada o pausada por Meta** | Esa plantilla no sale | Error en los registros de Vercel; el estado se ve en WhatsApp Manager |

### 4.4 Revisión semanal (10 minutos)

1. Consola: ¿hay chats rojos de días anteriores sin atender?
2. Portal de **Bold**: ¿hay pagos cuyas citas no se confirmaron?
3. **OpenAI** → Usage: ¿el consumo está en lo esperado?
4. **Upstash** → Usage: ¿cuántos comandos van este mes?
5. **Agenda:** probar enviando un mensaje de prueba a Gema desde un celular propio.
6. **WhatsApp Manager:** calidad del número (verde) y estado de las plantillas (aprobadas, ninguna pausada).

### 4.5 Revisión mensual

- Facturas de Vercel, OpenAI, Upstash y el consumo de plantillas en Meta (ver sección 1).
- Revisar si **Meta, Bold, OpenAI o Vercel** cambiaron tarifas.
- Revisar el vencimiento de la **promoción** y actualizar precios, horarios y 2x1.
- Cambiar la clave del panel si salió alguien del equipo.

### 4.6 Si Gema no responde: lista de chequeo

1. ¿Abre `https://premier-agente.vercel.app`? Si no → revisar Vercel.
2. ¿OpenAI tiene saldo? → platform.openai.com → Billing.
3. ¿El token de WhatsApp sigue vigente? → Meta Business → Usuarios del sistema.
4. ¿Upstash está activo y dentro del plan? → console.upstash.com.
5. ¿Meta muestra el webhook como verificado? → Meta for Developers → WhatsApp → Configuration.
6. Si todo está bien, escribir al desarrollador con la hora y el número del cliente afectado.

### 4.7 Seguridad y datos

- Gema guarda **solo lo necesario para agendar**: el nombre completo de quien se hace la sesión (y el de su acompañante en el 2x1) y su número de WhatsApp. No pide cédula, correo ni otros datos.
- Aun así, los chats son información de las clientas: no compartir capturas de la consola fuera del equipo.
- El panel pide clave; no dejarlo abierto en computadores compartidos.

---

## 5. Estado del proyecto y pendientes

**Avance estimado: ≈ 90 %.** La atención, la agenda, el cobro y las automatizaciones están programados y probados. Lo que falta es sobre todo configuración y la aprobación de las plantillas.

Pendiente para considerarlo cerrado:

- [ ] **ID de la cuenta de WhatsApp Business (WABA)**, para revisar las plantillas aprobadas (textos, botones y estado) contra lo programado.
- [ ] **Imágenes** `plantilla_retomar_cita.jpg` y `plantilla_ultimos_dias_bono.jpg`, para la carpeta `public/plantillas/`.
- [ ] Configurar `CRON_SECRET` y el programador (Vercel Cron o cron-job.org), y probar los mensajes automáticos.
- [ ] Activar `WHATSAPP_TEMPLATES=on` cuando las plantillas estén aprobadas.
- [ ] Pasar Vercel a **Pro** (sección 1.2).
- [ ] Activar tope de gasto en **OpenAI** y **Upstash** (secciones 1.3 y 1.4).
- [ ] Confirmar que el **token de WhatsApp es permanente**.
- [ ] Confirmar con Bold la **tarifa real** del contrato.
- [ ] Pasar las cuentas (Meta, Vercel, OpenAI, Upstash, GitHub, Bold) a **titularidad de Premier** y completar la tabla de accesos (sección 4.2).
- [ ] Guardar las claves en un gestor de contraseñas compartido por dos personas.
- [ ] Segunda versión de este manual, con capturas de pantalla del panel.

*Fin del borrador v1.*
