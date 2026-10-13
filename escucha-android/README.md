# Cuadre Escucha (prototipo)

App de Android para el teléfono donde llegan los avisos del banco. Lee las notificaciones
(con el permiso que da el dueño), y solo cuando son un **pago recibido de un banco** las
envía a la nube del comercio. La caja de Cuadre las lee y verifica la venta sola.

- Fuentes aceptadas: apps de bancos venezolanos y SMS de **códigos cortos** (los bancos escriben
  desde números como 2662). Un SMS desde un número normal se ignora: el teléfono de Pago Móvil
  es público y cualquiera podría mandar un SMS falso.
- Nunca pide claves ni entra al banco. Sin internet, los avisos esperan en una cola.
- Vinculación: en Cuadre, Ajustes → Verificación automática → Activar; copiar el código y
  tocar "Pegar código de Cuadre" en esta app (o compartir el mensaje de WhatsApp hacia la app).

Se compila en GitHub Actions (`.github/workflows/escucha-apk.yml`); el APK queda como artefacto.
La nube es Supabase con `nube/escucha.sql`.
