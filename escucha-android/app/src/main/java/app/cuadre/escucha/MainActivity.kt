package app.cuadre.escucha

import android.app.Activity
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Pantalla única: vincular con la caja, dar el permiso y ver qué salió del teléfono. */
class MainActivity : Activity() {
    private lateinit var estadoVinculo: TextView
    private lateinit var estadoPermiso: TextView
    private lateinit var estadoCola: TextView
    private lateinit var mensaje: TextView
    private lateinit var historial: TextView
    private lateinit var botonPermiso: Button
    private lateinit var botonPegar: Button
    private lateinit var botonProbar: Button
    private lateinit var botonDesvincular: Button

    private val verde = Color.parseColor("#047857")
    private val rojo = Color.parseColor("#B91C1C")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()

        val columna = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(28))
        }
        fun texto(t: String = "", tam: Float = 16f, negrita: Boolean = false): TextView = TextView(this).apply {
            text = t
            textSize = tam
            setTextColor(Color.parseColor("#13241D"))
            if (negrita) typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(6), 0, dp(6))
            columna.addView(this)
        }
        fun boton(t: String, accion: () -> Unit): Button = Button(this).apply {
            text = t
            isAllCaps = false
            textSize = 16f
            setOnClickListener { accion() }
            columna.addView(this, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(8)
            })
        }

        texto("Cuadre Escucha", 26f, true)
        texto("Cuando tu banco te avisa de un Pago Móvil recibido, esta app se lo pasa a tu caja de Cuadre y la venta queda verificada sola. " +
            "Solo envía avisos de pago de bancos. Nunca pide tus claves ni entra a tu banco.", 15f)
        estadoVinculo = texto(negrita = true)
        botonPegar = boton("Pegar código de Cuadre") { pegarCodigo() }
        estadoPermiso = texto(negrita = true)
        botonPermiso = boton("Dar permiso para leer avisos") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        estadoCola = texto(tam = 14f)
        botonProbar = boton("Probar conexión con la caja") { probar() }
        mensaje = texto(tam = 15f, negrita = true).apply { visibility = View.GONE }
        texto("Últimos avisos", 14f, true).apply { setPadding(0, dp(18), 0, 0) }
        historial = texto(tam = 13f).apply { typeface = Typeface.MONOSPACE }
        botonDesvincular = boton("Desvincular este teléfono") {
            Ajustes.desvincular(this)
            avisar("Listo. Este teléfono ya no envía avisos.", false)
            pintar()
        }

        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#F3F7F5"))
            addView(columna)
        })
        columna.gravity = Gravity.TOP
        procesar(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        procesar(intent)
    }

    override fun onResume() {
        super.onResume()
        pintar()
        if (Ajustes.vinculo(this) != null) Nube.vaciar(this) { runOnUiThread { pintar() } }
    }

    /** Código que llega por enlace (cuadreescucha://vincular?codigo=…) o compartido desde WhatsApp. */
    private fun procesar(intent: Intent?) {
        val texto = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data?.getQueryParameter("codigo")
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            else -> null
        } ?: return
        vincular(texto)
    }

    private fun pegarCodigo() {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val texto = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        if (texto.isNullOrBlank()) return avisar("Primero copia el código que muestra Cuadre en Ajustes.", true)
        vincular(texto)
    }

    private fun vincular(texto: String) {
        val v = Ajustes.leerCodigo(texto) ?: return avisar("Ese no es un código de Cuadre. Debe empezar por CUADRE1.", true)
        Ajustes.guardar(this, v)
        avisar("¡Vinculado con tu caja!", false)
        pintar()
    }

    private fun probar() {
        avisar("Probando…", false)
        Nube.probar(this) { error ->
            runOnUiThread {
                if (error == null) avisar("Conexión correcta con la nube de Cuadre.", false)
                else avisar("No se pudo conectar: $error", true)
            }
        }
    }

    private fun permisoActivo(): Boolean {
        val activos = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val yo = ComponentName(this, EscuchaService::class.java).flattenToString()
        return activos.split(":").any { it == yo }
    }

    private fun avisar(texto: String, error: Boolean) {
        mensaje.text = texto
        mensaje.setTextColor(if (error) rojo else verde)
        mensaje.visibility = View.VISIBLE
    }

    private fun pintar() {
        val vinculado = Ajustes.vinculo(this) != null
        val permiso = permisoActivo()
        estadoVinculo.text = if (vinculado) "✓ Vinculado con tu caja" else "1. Vincula este teléfono con tu caja"
        estadoVinculo.setTextColor(if (vinculado) verde else rojo)
        botonPegar.text = if (vinculado) "Cambiar código" else "Pegar código de Cuadre"
        estadoPermiso.text = if (permiso) "✓ Permiso para leer avisos activo" else "2. Dale permiso para leer los avisos del banco"
        estadoPermiso.setTextColor(if (permiso) verde else rojo)
        botonPermiso.visibility = if (permiso) View.GONE else View.VISIBLE
        botonProbar.isEnabled = vinculado
        botonDesvincular.visibility = if (vinculado) View.VISIBLE else View.GONE
        val pendientes = Nube.pendientes(this)
        estadoCola.text = if (pendientes > 0) "$pendientes aviso(s) esperando internet para salir." else
            if (vinculado && permiso) "Todo listo. Puedes cerrar esta pantalla; sigue funcionando." else ""
        val h = Nube.historial(this)
        historial.text = if (h.isEmpty()) "Todavía no ha llegado ningún aviso de pago." else h.joinToString("\n\n")
    }
}
