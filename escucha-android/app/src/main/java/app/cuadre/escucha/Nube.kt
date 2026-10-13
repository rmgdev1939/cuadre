package app.cuadre.escucha

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * Envía los avisos a la nube. Si no hay internet quedan en una cola y salen después,
 * con la hora en que llegaron al teléfono.
 */
object Nube {
    private val hilo = Executors.newSingleThreadExecutor()
    private const val MAX_COLA = 200
    private const val MAX_HISTORIAL = 10

    private fun ahoraIso(): String {
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date())
    }

    @Synchronized
    private fun cola(ctx: Context): JSONArray = JSONArray(Ajustes.prefs(ctx).getString("cola", "[]"))

    @Synchronized
    private fun guardarCola(ctx: Context, cola: JSONArray) {
        Ajustes.prefs(ctx).edit().putString("cola", cola.toString()).apply()
    }

    fun pendientes(ctx: Context): Int = cola(ctx).length()

    @Synchronized
    fun encolar(ctx: Context, texto: String, origen: String) {
        val c = cola(ctx)
        c.put(JSONObject().put("texto", texto.take(600)).put("origen", origen.take(120)).put("recibido", ahoraIso()))
        while (c.length() > MAX_COLA) c.remove(0)
        guardarCola(ctx, c)
        anotar(ctx, texto, "en cola")
    }

    /** Intenta enviar la cola en orden. Se detiene en el primer fallo. */
    fun vaciar(ctx: Context, alTerminar: ((String?) -> Unit)? = null) {
        val app = ctx.applicationContext
        hilo.execute {
            var error: String? = null
            val v = Ajustes.vinculo(app)
            if (v == null) {
                error = "Sin vincular"
            } else {
                while (true) {
                    val c = cola(app)
                    if (c.length() == 0) break
                    val aviso = c.getJSONObject(0)
                    try {
                        publicar(v, aviso.getString("texto"), aviso.optString("origen"), aviso.optString("recibido"))
                        quitarPrimero(app)
                        anotar(app, aviso.getString("texto"), "enviado")
                    } catch (e: Exception) {
                        error = e.message ?: "Error de red"
                        break
                    }
                }
            }
            alTerminar?.invoke(error)
        }
    }

    /** Envía un mensaje de prueba (no es un pago, Cuadre lo ignora) para revisar la conexión. */
    fun probar(ctx: Context, alTerminar: (String?) -> Unit) {
        val v = Ajustes.vinculo(ctx) ?: return alTerminar("Sin vincular")
        hilo.execute {
            try {
                publicar(v, "Prueba de conexión de Cuadre Escucha", "prueba", ahoraIso())
                alTerminar(null)
            } catch (e: Exception) {
                alTerminar(e.message ?: "Error de red")
            }
        }
    }

    @Synchronized
    private fun quitarPrimero(ctx: Context) {
        val c = cola(ctx)
        if (c.length() > 0) c.remove(0)
        guardarCola(ctx, c)
    }

    private fun publicar(v: Vinculo, texto: String, origen: String, recibido: String) {
        val cuerpo = JSONObject()
            .put("p_canal", v.canal)
            .put("p_texto", texto)
            .put("p_origen", origen)
            .put("p_recibido", recibido.ifEmpty { ahoraIso() })
            .toString()
        val con = URL(v.url + "/rest/v1/rpc/escucha_publicar").openConnection() as HttpURLConnection
        try {
            con.requestMethod = "POST"
            con.connectTimeout = 10000
            con.readTimeout = 10000
            con.doOutput = true
            con.setRequestProperty("Content-Type", "application/json")
            con.setRequestProperty("apikey", v.clave)
            con.setRequestProperty("Authorization", "Bearer " + v.clave)
            con.outputStream.use { it.write(cuerpo.toByteArray(Charsets.UTF_8)) }
            val codigo = con.responseCode
            if (codigo !in 200..299) throw Exception("La nube respondió $codigo")
        } finally {
            con.disconnect()
        }
    }

    /** Últimos avisos, para que el dueño vea qué salió del teléfono. */
    @Synchronized
    fun historial(ctx: Context): List<String> {
        val h = JSONArray(Ajustes.prefs(ctx).getString("historial", "[]"))
        return (0 until h.length()).map { h.getString(it) }
    }

    @Synchronized
    private fun anotar(ctx: Context, texto: String, estado: String) {
        val h = JSONArray(Ajustes.prefs(ctx).getString("historial", "[]"))
        val hora = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
        val nuevo = JSONArray().put("$hora · $estado · ${texto.take(90)}")
        for (i in 0 until minOf(h.length(), MAX_HISTORIAL - 1)) nuevo.put(h.getString(i))
        Ajustes.prefs(ctx).edit().putString("historial", nuevo.toString()).apply()
    }
}
