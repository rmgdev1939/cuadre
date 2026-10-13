package app.cuadre.escucha

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Recibe las notificaciones del teléfono (con el permiso que da el dueño) y manda a la nube
 * solo los avisos de pago recibido de un banco. No pide claves ni lee el banco por dentro.
 */
class EscuchaService : NotificationListenerService() {
    // Las notificaciones se actualizan y repiten: no se envía dos veces el mismo texto.
    private val recientes = ArrayDeque<String>()

    override fun onListenerConnected() {
        Nube.vaciar(this)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (Ajustes.vinculo(this) == null) return
        val extras = sbn.notification?.extras ?: return
        val titulo = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val cuerpo = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        val texto = "$titulo $cuerpo".trim()
        if (texto.isEmpty() || !Filtro.aceptar(sbn.packageName, titulo, texto)) return
        val huella = texto.hashCode().toString()
        synchronized(recientes) {
            if (huella in recientes) return
            recientes.addLast(huella)
            while (recientes.size > 50) recientes.removeFirst()
        }
        Nube.encolar(this, texto, sbn.packageName)
        Nube.vaciar(this)
    }
}
