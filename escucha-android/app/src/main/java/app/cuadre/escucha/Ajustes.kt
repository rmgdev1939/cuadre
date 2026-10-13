package app.cuadre.escucha

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import org.json.JSONObject

/** Vínculo con las cajas del comercio: dirección de la nube, clave pública y canal secreto. */
data class Vinculo(val url: String, val clave: String, val canal: String)

object Ajustes {
    private const val PREFS = "cuadre-escucha"
    private val RE_CODIGO = Regex("CUADRE1\\.([A-Za-z0-9_-]{20,})")
    private val RE_CANAL = Regex("^[A-Za-z0-9_-]{20,80}$")

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Lee el código que muestra Cuadre en Ajustes (puede venir dentro de un mensaje). */
    fun leerCodigo(texto: String?): Vinculo? {
        val m = RE_CODIGO.find(texto ?: return null) ?: return null
        return try {
            val json = String(Base64.decode(m.groupValues[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)
            val o = JSONObject(json)
            val url = o.getString("u").trimEnd('/')
            val clave = o.getString("k")
            val canal = o.getString("c")
            val urlValida = url.startsWith("https://") || url.startsWith("http://10.0.2.2") || url.startsWith("http://127.0.0.1")
            if (!urlValida || clave.isEmpty() || !RE_CANAL.matches(canal)) null else Vinculo(url, clave, canal)
        } catch (e: Exception) {
            null
        }
    }

    fun vinculo(ctx: Context): Vinculo? {
        val p = prefs(ctx)
        val url = p.getString("url", null) ?: return null
        val clave = p.getString("clave", null) ?: return null
        val canal = p.getString("canal", null) ?: return null
        return Vinculo(url, clave, canal)
    }

    fun guardar(ctx: Context, v: Vinculo) {
        prefs(ctx).edit().putString("url", v.url).putString("clave", v.clave).putString("canal", v.canal).apply()
    }

    fun desvincular(ctx: Context) {
        prefs(ctx).edit().remove("url").remove("clave").remove("canal").remove("cola").apply()
    }
}
