# Cambios del panel y de Gema

La versión se muestra en el panel y en la pantalla de inicio de sesión (sale de `package.json`).
Para publicar una actualización: sube la versión en `package.json` (y `package-lock.json`) y anótala aquí.

## 1.6.3 · 21 de octubre de 2026

- Las plantillas de Meta manuales pasan al panel de control, plegadas bajo "Mensajes prediseñados" como **"Plantillas de Meta · solo emergencias"**. Las plantillas siguen saliendo solas; esto es solo para adelantar una.
- **Anti-spam**: una sola plantilla por cliente hasta que responda (manual o automática), máximo una de marketing cada 3 días, y nunca entre 9 p.m. y 8 a.m. El servidor lo bloquea aunque se intente.
- **Franja de silencio reforzada (9 p.m. a 8 a.m.)**: además de las automatizaciones, ahora tampoco se contestan de madrugada los mensajes que Meta entrega con retraso ni los que quedaron sin responder; esperan a las 8 a.m. Gema sí responde a quien le escribe en ese momento.
- Confirmaciones con la estética del panel en lugar del cuadro del navegador.
- Las plantillas ya no saludan con iniciales ("Hola Ll"): si el nombre son iniciales, dicen "Hola de nuevo".

## 1.6.2 · 20 de octubre de 2026

- **Plantillas de Meta desde el panel**: con la ventana de 24 h cerrada se ofrecen con las plantillas que aplican a ese cliente (retomar, últimos días del 2x1, anticipo pendiente, recordatorio), la más lógica marcada como "Sugerida" y las que no aplican deshabilitadas con el motivo. Al enviar una, se quita la alerta y Gema vuelve a atender el chat para responder cuando el cliente conteste.
- Corrección: la plantilla automática de retomar no salía para los chats que el propio sistema había marcado "Requiere asesor" por un mensaje tardío, porque esa alerta pausa a Gema. Ahora sí sale y, al enviarse, Gema retoma el chat.

## 1.6.1 · 20 de octubre de 2026

- Nueva opción de pago al crear o editar una cita: **"Limpieza de cortesía (por compra de productos)"**. No se cobra, no se reporta a Meta como venta, y si se cancela no pide reembolso. Recibe los recordatorios igual que las demás.

## 1.6 · 20 de octubre de 2026

**2x1 con una sola cabina**
- Cada sede tiene una cabina: las dos personas del 2x1 se agendan una después de la otra (la segunda empieza al terminar la primera). La cita ocupa la cabina el tiempo de las dos sesiones y se paga como una sola (2x1). Gema lo explica así y nunca dice que no se puede venir en pareja; la bienvenida vuelve a mostrar horarios para venir con acompañante.

**Pagos en la agenda**
- Las citas creadas a mano mostraban un anticipo de $50.000 que venía por defecto y nadie había cobrado. Ahora el asesor elige al crearla (y al editarla): "paga todo en la sede", "ya pagó el anticipo" o "ya pagó la sesión completa". La ficha y la grilla muestran cuánto falta cobrar. Las 13 citas manuales existentes quedaron como "paga en la sede": si alguna sí pagó anticipo, se corrige con "Editar cita".

**Métricas**
- "Citas hoy" pasa a llamarse "Agendados hoy" (chats que se agendaron hoy). El 42 venía de las pruebas del 20 de octubre corridas sobre la base real antes de que existiera el prefijo de pruebas; se recalculó con los chats reales.

## 1.5 · 20 de octubre de 2026

**Clientes con número oculto**
- Al agendar, Gema le pide un celular de contacto a quien escribe con nombre de usuario de WhatsApp (Meta no entrega su número). Es opcional: si no lo da, agenda igual. El celular queda en el chat y en la cita, con enlace para escribirle.

**Editar citas**
- Botón "Editar cita" en la ficha: nombre, acompañante, WhatsApp (o celular de contacto), servicio, sede, día y hora. Al cambiar de servicio se recalcula el valor y se conserva lo ya pagado. Las horas que ofrece cuentan como libre el lugar de la misma cita.

**Asesores**
- Botón "Asesores" en la agenda: editar el nombre de un asesor (se actualiza en la lista y en todas sus citas) o quitarlo de la lista (sus citas conservan el nombre). El selector de la cita ya no tiene "Quitar de la lista".

**Agenda verificada**
- La nota de disponibilidad dice explícitamente cuando una sede tiene una sola cabina (no se pueden agendar dos personas a la misma hora), para que Gema no lo confunda con "no hay espacio".

## 1.4 · 20 de octubre de 2026

**Gema vende, no solo informa**
- Nuevo método de venta (Configuración → Voz y método de venta): diagnostica el dolor de la piel, lo conecta con el producto que lo resuelve, apila el valor del ritual de 5 pasos, usa la limpieza cero invasiva contra el miedo, recuerda la fecha real del 2x1 y cierra con una pregunta de doble alternativa.
- Nueva base de conocimiento (Configuración → Conocimiento de Premier) desde los documentos de entrenamiento: el ritual de 5 pasos, las líneas azul y roja, cada limpieza y sus productos con composición y uso.
- Bienvenida y seguimientos reescritos con ese conocimiento y **editables en el panel** (Configuración → Mensajes prediseñados), con vista previa y "Restaurar original". Desde el panel de control del chat se pueden **enviar a mano** si fallaron.

**Pagos**
- Anticipo simbólico de **$25.000** que se descuenta del valor, explicado como pago seguro para asegurar el espacio.
- **Cortesía por agendar con anticipo**: exfoliación de manos con la sal del Mar Muerto. Queda en las notas de la cita.
- **Efectivo**: quien lo pide se agenda sin anticipo (antes el interruptor estaba apagado y Gema seguía pidiendo el anticipo). Se reconocen más formas de decirlo ("pago cuando llegue", "en el lugar", "en físico"). Gema nunca lo ofrece por su cuenta.

**Agenda**
- Gema verifica la agenda real del día y la sede que pregunta el cliente antes de responder (una clienta pidió Chipichape el miércoles 21 en la tarde, había espacio y Gema dijo que no).
- Campo **Asesor** en cada cita ("Gema" en las suyas; obligatorio al agendar a mano; se puede reasignar).
- Vista **mensual** además de la semanal.

**Mensajes y spam**
- "Ahora no", "no me interesa", "no gracias", "no me escribas más"… detienen **todos** los mensajes automáticos de ese chat. El panel lo muestra y permite reactivarlo.
- La plantilla `retomar_cita_limpieza` ahora también se envía (hasta 7 días) a quien nunca recibió respuesta a su último mensaje, y se les quita la alerta de asesor. Antes solo salía entre 24 y 48 h de silencio.
- Mensajes que quedan sin respuesta más de 5 minutos (entrega tardía de Meta, caída) se responden en la siguiente corrida del programador, a cualquier hora, con una disculpa por la demora. Los que llegan con más de 24 h de retraso pasan a una asesora. Antes se guardaban en silencio.

**Consumo de Upstash (360 mil comandos de 500 mil)**
- Una pestaña del panel abierta gastaba ~22.800 comandos por hora: releía la bandeja completa cada 8 s (36 comandos con 34 chats), el chat abierto cada 4 s, las métricas cada 15 s, y el control de abuso del middleware sumaba 2 comandos por consulta.
- Ahora el panel pregunta "¿cambió algo?" (1 comando, `/api/revision`) y solo recarga cuando cambia. Si nadie toca el panel en 3 minutos, pregunta cada 30 s. Recarga completa de respaldo cada 5 min (30 min si está desatendido). El middleware ya no cuenta las lecturas.
- La disponibilidad que recibe Gema en cada respuesta (46 comandos) se guarda 5 minutos y se recalcula apenas cambia la agenda o la configuración.
- El vigilante de mensajes sin responder usa un índice propio (`pm:awaiting`): 1 comando por corrida en vez de leer toda la bandeja.

**Eventos de conversión (Meta)**
- Las citas pagadas en efectivo también se reportan como *Purchase* (valor completo) cuando la asesora marca la cita como "Realizada". Si el anticipo ya se había reportado, el mismo event_id evita contarla dos veces.

**Teléfonos y recordatorios de la agenda**
- Campo de teléfono con indicativo: +57 por defecto y "Otro…" para escribir cualquier indicativo. En las citas que se crean a mano, un celular colombiano de 10 dígitos se completa con 57 (los números que llegan por WhatsApp ya traen su indicativo y no se tocan). Se corrigieron 2 citas que estaban sin él.
- Las citas que agenda un asesor en el panel reciben recordatorio con plantilla un día antes y 2 h antes, aunque el cliente nunca haya escrito a Gema.

**Plantillas**
- `anticipo_pendiente` solo a quien ya eligió cómo pagar el anticipo (pidió el link o recibió los datos para transferir). Nunca a citas en efectivo.
- `ultimos_dias_bono` a los 5 días de silencio de quien preguntó y no agendó, y otra vez en los 4 últimos días del 2x1 (del 27 al 31 de octubre). Una plantilla de marketing cada 3 días por persona como máximo.

**Asesores**
- Los nombres de los asesores se guardan en la base y se eligen de una lista ("+ Nuevo asesor…" para agregar, "Quitar de la lista" para borrar uno mal escrito). Se cargaron los 7 que ya estaban en las citas.

**Webhook de WhatsApp**
- Un mensaje con una forma inesperada ya no tumba la entrega completa: se guarda como "no se pudo leer", el chat pasa a una asesora y la entrega sigue. Los mensajes sin remitente quedan registrados en `pm:wa:rejected` con su tipo y campos.

**Visual**
- Modo oscuro en un verde mucho más profundo, casi negro.
- (Se probó el patrón de cristal en el fondo del chat y de la agenda y se quitó: no se veía bien.)
- Etiqueta de versión en el panel y en el inicio de sesión.
- Desbordes corregidos: nombre de la marca en la barra lateral, encabezado del chat y valores largos del panel de control (motivo, conversión, automáticos).
- Círculo "OP" del operador en el tan de la marca.

**Configuración guardada**: al leer la configuración de producción por primera vez, la v1.4 aplica sola el prompt y el conocimiento nuevos, el anticipo de $25.000, el efectivo encendido, la cortesía y los mensajes prediseñados (ver `CONFIG_REVISION` en `lib/config.ts`). Catálogo, precios, horarios, promoción y preguntas frecuentes no se tocan.
