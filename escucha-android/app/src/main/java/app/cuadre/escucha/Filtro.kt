package app.cuadre.escucha

/**
 * Decide qué notificaciones son avisos de pago RECIBIDO de un banco.
 * Solo esas salen del teléfono; el resto (chats, correos, otras apps) nunca se envía.
 *
 * Seguridad: el número de Pago Móvil del comercio es público, así que cualquiera puede
 * mandarle un SMS falso que diga "Recibiste Bs 1.720,00". Por eso de las apps de SMS
 * solo se aceptan mensajes de códigos cortos (los bancos escriben desde 2662, 2846…),
 * nunca de un número de teléfono normal ni de un contacto.
 */
object Filtro {
    private val APPS_SMS = setOf(
        "com.google.android.apps.messaging",
        "com.android.mms",
        "com.android.messaging",
        "com.samsung.android.messaging",
        "com.motorola.messaging",
        "com.oneplus.mms",
        "com.huawei.message",
        "com.sonyericsson.conversations",
        "com.textra"
    )

    // Apps de bancos venezolanos: se reconocen por el nombre del paquete.
    private val RE_APP_BANCO = Regex(
        "banco|banesco|mercantil|provincial|bbva|bdv|bancaribe|bnc|bancamiga|tesoro|plaza|banplus|" +
            "exterior|bancoactivo|bicentenario|bfc|fondocomun|sofitasa|caroni|100banco|delsur|bancrecer|venezolano",
        RegexOption.IGNORE_CASE
    )

    private val RE_CODIGO_CORTO = Regex("^\\d{3,6}$")
    private val RE_MONTO = Regex("(?:bs\\.?\\s*s?\\.?|ves)\\s*:?\\s*\\d|\\d[\\d.,]*\\s*(?:bs\\b|bs\\.|ves\\b)", RegexOption.IGNORE_CASE)
    private val RE_RECIBIDO = Regex(
        "recib|abon|acredit|pago\\s*m[oó]vil|pagomovil|transferencia|cr[eé]dito|te\\s+pag",
        RegexOption.IGNORE_CASE
    )
    private val RE_ENVIADO = Regex(
        "\\b(enviaste|has enviado|pagaste|realizaste un pago|debitad[oa]|d[eé]bito)\\b",
        RegexOption.IGNORE_CASE
    )

    /** ¿Viene de una fuente de confianza (app de banco, o SMS de un código corto)? */
    fun fuenteConfiable(paquete: String, titulo: String): Boolean {
        if (paquete in APPS_SMS) return RE_CODIGO_CORTO.matches(titulo.replace(" ", ""))
        return RE_APP_BANCO.containsMatchIn(paquete)
    }

    /** ¿El texto parece un pago recibido con monto en bolívares? */
    fun pareceCobro(texto: String): Boolean =
        RE_MONTO.containsMatchIn(texto) && RE_RECIBIDO.containsMatchIn(texto) && !RE_ENVIADO.containsMatchIn(texto)

    fun aceptar(paquete: String, titulo: String, texto: String): Boolean =
        paquete != "app.cuadre.escucha" && fuenteConfiable(paquete, titulo) && pareceCobro(texto)
}
