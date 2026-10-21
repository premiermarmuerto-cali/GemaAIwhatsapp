# Cambios del panel y de Gema

La versión se muestra en el panel y en la pantalla de inicio de sesión (sale de `package.json`).
Para publicar una actualización: sube la versión en `package.json` (y `package-lock.json`) y anótala aquí.

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

**Webhook de WhatsApp**
- Un mensaje con una forma inesperada ya no tumba la entrega completa: se guarda como "no se pudo leer", el chat pasa a una asesora y la entrega sigue. Los mensajes sin remitente quedan registrados en `pm:wa:rejected` con su tipo y campos.

**Visual**
- Modo oscuro en un verde mucho más profundo, casi negro.
- (Se probó el patrón de cristal en el fondo del chat y de la agenda y se quitó: no se veía bien.)
- Etiqueta de versión en el panel y en el inicio de sesión.
- Desbordes corregidos: nombre de la marca en la barra lateral, encabezado del chat y valores largos del panel de control (motivo, conversión, automáticos).
- Círculo "OP" del operador en el tan de la marca.

**Configuración guardada**: al leer la configuración de producción por primera vez, la v1.4 aplica sola el prompt y el conocimiento nuevos, el anticipo de $25.000, el efectivo encendido, la cortesía y los mensajes prediseñados (ver `CONFIG_REVISION` en `lib/config.ts`). Catálogo, precios, horarios, promoción y preguntas frecuentes no se tocan.
