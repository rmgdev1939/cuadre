/*
 * CUADRE · app.js
 * Calculadora de pagos mixtos: total de la factura en USD, efectivo recibido en USD
 * y, con la tasa BCV activa, el restante a cobrar en Bs (Pago Móvil) o el vuelto en USD.
 * Al cobrar registra la venta (db.js, window.CuadreDB) y muestra el Recibo Exprés
 * con envío por WhatsApp. "Cerrar Caja" resume las ventas abiertas y las archiva; desde ahí
 * se consultan y reenvían los cierres anteriores. Las ventas abiertas se pueden anular (quedan
 * tachadas y fuera de los totales, nunca se borran). Ajustes exporta e importa un respaldo JSON.
 * La pizarra muestra la tasa BCV USD (la única que usan los cálculos) y, como referencia,
 * las tasas EUR y Paralelo/Binance. Ajustes guarda el nombre, RIF/teléfono, logo y tema del comercio.
 * Los Bs se cobran por Pago Móvil o Punto de venta. El Pago Móvil abre una hoja con el monto exacto,
 * los datos del comercio y la referencia; la venta queda "por verificar" hasta emparejarla con el SMS
 * del banco del comerciante (compartido a la app o pegado; pagomovil.js lo lee).
 * Inventario opcional: se cobra tocando productos (el total sale de ellos y el stock baja solo) o
 * tecleando el monto como siempre. El dashboard resume ventas, métodos y productos por período.
 *
 * Todos los montos se manejan en centavos enteros para evitar errores de coma
 * flotante; solo se convierten a decimales al mostrarlos o guardarlos.
 */
(function () {
  'use strict';

  var DB = window.CuadreDB;
  var PM = window.CuadrePM;
  var MAX_DIGITOS_ENTEROS = 7;

  // ---------- Estado ----------
  var estado = {
    tasa: null,              // tasa BCV USD { valor, fecha } o null
    tasasRef: { eur: null, paralelo: null }, // tasas de referencia { valor, fecha } o null
    comercio: { nombre: '', contacto: '', logo: null, tema: null },
    campoActivo: 'total',    // 'total' | 'recibido' (efectivo USD)
    entrada: { total: '', recibido: '' }, // texto tecleado, p. ej. "12.5"
    canalBs: 'pago-movil',   // cómo se cobran los Bs: 'pago-movil' | 'punto'
    pagos: [],               // pagos recibidos leídos de SMS (copia de CuadreDB.pagosRecibidos)
    catalogo: [],            // productos activos (copia de CuadreDB.obtenerCatalogo)
    carrito: {},             // productoId → cantidad de la venta en curso
    dashPeriodo: 'hoy',      // 'hoy' | '7' | '30'
    recibo: null             // última venta cobrada, para el Recibo Exprés
  };

  // ---------- Utilidades numéricas y de formato ----------
  var fmtMonto = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var fmtTasa = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  var fmtHora = new Intl.DateTimeFormat('es-VE', { hour: '2-digit', minute: '2-digit' });
  var fmtFecha = new Intl.DateTimeFormat('es-VE', { dateStyle: 'medium', timeStyle: 'short' });
  var fmtFechaCorta = new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  var fmtFechaRecibo = new Intl.DateTimeFormat('es-VE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  /** "12.5" → 1250 centavos. Cadena vacía → null. */
  function aCentavos(texto) {
    if (texto === '' || texto === '.') return null;
    var partes = texto.split('.');
    var enteros = parseInt(partes[0] || '0', 10);
    var dec = ((partes[1] || '') + '00').slice(0, 2);
    return enteros * 100 + parseInt(dec, 10);
  }

  /** Centavos USD × tasa → centavos Bs (redondeado). */
  function aBsCentavos(centavosUsd, tasa) {
    return Math.round(centavosUsd * tasa);
  }

  function usd(centavos) { return '$' + fmtMonto.format(centavos / 100); }
  function bs(centavos) { return 'Bs ' + fmtMonto.format(centavos / 100); }

  /** Acepta "36,50" o "36.50" o "1.234,56" y devuelve número o NaN. */
  function parsearTasa(texto) {
    var t = String(texto || '').trim().replace(/\s/g, '');
    if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.');
    return t === '' ? NaN : Number(t);
  }

  // ---------- DOM ----------
  function $(sel) { return document.querySelector(sel); }

  var el = {};

  function poner(nodo, texto) {
    if (!nodo) return;
    if ('value' in nodo && (nodo.tagName === 'INPUT' || nodo.tagName === 'OUTPUT' || nodo.tagName === 'TEXTAREA')) {
      nodo.value = texto;
    }
    if (nodo.tagName !== 'INPUT' && nodo.tagName !== 'TEXTAREA') nodo.textContent = texto;
  }

  // ---------- Pizarra de tasas ----------
  function mostrarTasa() {
    if (estado.tasa) {
      poner(el.tasaActual, fmtTasa.format(estado.tasa.valor));
      poner(el.tasaFecha, origenTasa(estado.tasa, 'bcv'));
    } else {
      poner(el.tasaActual, 'Sin tasa');
      poner(el.tasaFecha, 'Conéctate a internet o toca «Editar Tasas» para escribir la tasa BCV del día');
    }
    [['eur', el.tasaEur, el.tasaEurFecha], ['paralelo', el.tasaParalelo, el.tasaParaleloFecha]].forEach(function (x) {
      var t = estado.tasasRef[x[0]];
      poner(x[1], t ? 'Bs ' + fmtMonto.format(t.valor) : '—');
      poner(x[2], origenTasa(t, x[0]));
    });
  }


  /** De dónde salió la tasa y de cuándo es: "DolarAPI · vigente 03/10" o "Manual · 03/10 09:15". */
  function origenTasa(t, tipo) {
    if (!t) return 'Sin registrar';
    if (!t.fuente) return 'Manual · ' + fmtFechaCorta.format(new Date(t.fecha));
    var f = new Date(t.fechaFuente || t.fecha);
    return t.fuente + ' · ' + (tipo === 'paralelo' ? fmtFechaCorta.format(f) : 'vigente ' + fmtDiaMes.format(f));
  }

  /** [tipo, input] de cada tasa en el diálogo Editar Tasas. */
  function camposTasas() {
    return [['bcv', el.tasaInput], ['eur', el.tasaEurInput], ['paralelo', el.tasaParaleloInput]];
  }

  function tasaGuardada(tipo) {
    return tipo === 'bcv' ? estado.tasa : estado.tasasRef[tipo];
  }

  function mensajeTasas(texto) {
    el.tasasMensaje.textContent = texto || '';
    el.tasasMensaje.hidden = !texto;
  }

  function abrirTasas() {
    if (!el.tasas) return;
    camposTasas().forEach(function (c) {
      var t = tasaGuardada(c[0]);
      c[1].value = '';
      c[1].removeAttribute('aria-invalid');
      c[1].placeholder = t ? 'Actual: ' + fmtTasa.format(t.valor) : 'Sin registrar';
    });
    mensajeTasas('');
    if (!el.tasas.open) el.tasas.showModal();
    // Sin tasa BCV, el cursor va directo a ella; si ya hay, no se abre el teclado del teléfono.
    if (!estado.tasa) el.tasaInput.focus(); else el.tasasCerrar.focus();
  }

  /** Guarda solo las tasas escritas; cada una registra su propia fecha y hora. */
  function guardarTasas(e) {
    if (e) e.preventDefault();
    var cambios = [];
    var campos = camposTasas();
    for (var i = 0; i < campos.length; i++) {
      var tipo = campos[i][0], input = campos[i][1];
      input.removeAttribute('aria-invalid');
      var texto = input.value.trim();
      if (!texto) continue;
      var valor = parsearTasa(texto);
      if (!isFinite(valor) || valor <= 0) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        mensajeTasas('Revisa esta tasa: usa un número como 36,50.');
        return;
      }
      cambios.push([tipo, valor]);
    }
    if (!estado.tasa && !cambios.some(function (c) { return c[0] === 'bcv'; })) {
      el.tasaInput.setAttribute('aria-invalid', 'true');
      el.tasaInput.focus();
      mensajeTasas('La tasa BCV USD es necesaria para cobrar.');
      return;
    }
    if (!cambios.length) { el.tasas.close(); return; }

    el.tasaGuardar.disabled = true;
    Promise.all(cambios.map(function (c) { return DB.guardarTasa(c[1], c[0]); })).then(function (guardadas) {
      cambios.forEach(function (c, i) {
        if (c[0] === 'bcv') estado.tasa = guardadas[i];
        else estado.tasasRef[c[0]] = guardadas[i];
      });
      mostrarTasa();
      recalcular();
      el.tasas.close();
    }).catch(function (err) {
      console.error(err);
      mensajeTasas('No se pudieron guardar las tasas. Intenta de nuevo.');
    }).then(function () {
      el.tasaGuardar.disabled = false;
    });
  }

  // ---------- Tasas automáticas ----------
  // Se buscan solas al abrir la app, al volver a ella y al recuperar internet (como mucho cada 30 min).
  // Son sugerencias: una tasa corregida a mano se respeta hasta que la fuente publique una más nueva.
  // Sin internet o si la fuente falla, se queda la última guardada y se sigue cobrando.
  var CLAVE_CONSULTA = 'cuadre-tasas-consulta';
  var CONSULTA_CADA_MS = 30 * 60 * 1000;
  var buscandoTasas = false;

  function ultimaConsulta() {
    try { return Number(localStorage.getItem(CLAVE_CONSULTA)) || 0; } catch (e) { return 0; }
  }

  function anotarConsulta(ms) {
    try { localStorage.setItem(CLAVE_CONSULTA, String(ms)); } catch (e) { /* sin almacenamiento */ }
  }

  function textoConsulta() {
    var u = ultimaConsulta();
    return u ? 'Consultadas: ' + fmtHora.format(new Date(u)) : '';
  }

  function estadoTasas(texto) { poner(el.tasasEstado, texto || ''); }

  function debeReemplazar(actual, nueva) {
    if (!actual) return true;
    if (actual.fuente) return actual.valor !== nueva.valor || actual.fechaFuente !== nueva.fechaFuente;
    return !!nueva.fechaFuente && Date.parse(nueva.fechaFuente) > Date.parse(actual.fecha);
  }

  function actualizarTasasSolas(forzar) {
    if (!window.CuadreTasas || buscandoTasas) return Promise.resolve();
    if (!navigator.onLine) {
      estadoTasas('Sin conexión: se usan las últimas tasas guardadas.');
      return Promise.resolve();
    }
    if (!forzar && Date.now() - ultimaConsulta() < CONSULTA_CADA_MS) {
      estadoTasas(textoConsulta());
      return Promise.resolve();
    }
    buscandoTasas = true;
    if (el.actualizarTasas) el.actualizarTasas.disabled = true;
    estadoTasas('Buscando las tasas del día…');
    var nombres = { bcv: 'BCV dólar', eur: 'BCV euro', paralelo: 'Binance' };
    return window.CuadreTasas.buscar().then(function (r) {
      var tipos = Object.keys(nombres);
      var llegaron = tipos.filter(function (t) { return r[t]; });
      var cambian = llegaron.filter(function (t) { return debeReemplazar(tasaGuardada(t), r[t]); });
      return Promise.all(cambian.map(function (t) {
        return DB.guardarTasa(r[t].valor, t, { fuente: r[t].fuente, fechaFuente: r[t].fechaFuente }).then(function (g) {
          if (t === 'bcv') estado.tasa = g; else estado.tasasRef[t] = g;
        });
      })).then(function () {
        if (!llegaron.length) {
          estadoTasas('No se pudieron consultar las tasas: se usan las últimas guardadas.');
          return;
        }
        anotarConsulta(Date.now());
        var faltan = tipos.filter(function (t) { return !r[t]; }).map(function (t) { return nombres[t]; });
        estadoTasas(textoConsulta() + (faltan.length ? ' · Sin respuesta: ' + faltan.join(', ') : ''));
        mostrarTasa();
        recalcular();
        llenarTasaRegistro();
      });
    }).catch(function (e) {
      console.warn(e);
      estadoTasas('No se pudieron consultar las tasas: se usan las últimas guardadas.');
    }).then(function () {
      buscandoTasas = false;
      if (el.actualizarTasas) el.actualizarTasas.disabled = false;
    });
  }

  /** En el registro, la tasa BCV ya viene puesta si se pudo consultar. */
  function llenarTasaRegistro() {
    if (el.registroTasa && !el.registroTasa.value && estado.tasa) el.registroTasa.value = fmtTasa.format(estado.tasa.valor);
  }

  // ---------- Ajustes del comercio (marca y tema) ----------
  var COLOR_BARRA = { esmeralda: '#047857', azul: '#1e40af', naranja: '#c2410c', oscuro: '#151f1e', logo: null };
  var VARIABLES_LOGO = {
    primario: '--primario', primarioOscuro: '--primario-oscuro', primarioSuave: '--primario-suave', fondo: '--fondo',
    bs: '--bs', bsSuave: '--bs-suave', tecla: '--tecla', teclaActiva: '--tecla-activa'
  };
  var LOGO_MAX_PX = 256;
  var LOGO_MAX_BYTES = 10 * 1024 * 1024;
  var logoPendiente; // undefined = sin cambios · null = quitar · string = nuevo logo (data URL)
  var coloresPendientes = null; // paleta del logo recién elegido, aún sin guardar

  function temaActual() {
    return document.documentElement.getAttribute('data-tema') || 'esmeralda';
  }

  /**
   * Aplica el tema al instante y deja una copia en localStorage para pintarlo antes de que cargue IndexedDB.
   * 'logo' usa los colores sacados del logo (`colores`); los demás temas limpian esos colores.
   */
  function aplicarTema(tema, colores) {
    if (!(tema in COLOR_BARRA)) return;
    var propios = tema === 'logo' ? (colores || estado.comercio.colores) : null;
    if (tema === 'logo' && !propios) return;
    var raiz = document.documentElement;
    raiz.setAttribute('data-tema', tema);
    Object.keys(VARIABLES_LOGO).forEach(function (k) {
      if (propios) raiz.style.setProperty(VARIABLES_LOGO[k], propios[k]);
      else raiz.style.removeProperty(VARIABLES_LOGO[k]);
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', propios ? propios.primario : COLOR_BARRA[tema]);
    try {
      localStorage.setItem('cuadre-tema', tema);
      if (propios) localStorage.setItem('cuadre-colores', JSON.stringify(propios));
    } catch (e) { /* modo privado: no pasa nada */ }
  }

  // ---------- Colores desde el logo ----------
  function hexARgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbAHex(rgb) {
    return '#' + rgb.map(function (v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }).join('');
  }
  function rgbAHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function hslAHex(h, s, l) {
    function f(n) {
      var k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    }
    return rgbAHex([f(0), f(8), f(4)]);
  }
  function luminancia(hex) {
    var c = hexARgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contraste(a, b) {
    var la = luminancia(a), lb = luminancia(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /**
   * Color dominante "con color" del logo: ignora fondos transparentes, blancos, negros y grises,
   * agrupa por tono y se queda con el grupo de más peso. Devuelve '#rrggbb' o null si el logo es gris.
   */
  function colorDominante(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var lado = 64;
        var lienzo = document.createElement('canvas');
        lienzo.width = lado; lienzo.height = lado;
        var ctx = lienzo.getContext('2d');
        ctx.drawImage(img, 0, 0, lado, lado);
        var px;
        try { px = ctx.getImageData(0, 0, lado, lado).data; } catch (e) { return resolve(null); }
        var grupos = {};
        for (var i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 200) continue;
          var rgb = [px[i], px[i + 1], px[i + 2]];
          var hsl = rgbAHsl(rgb);
          if (hsl[1] < 0.25 || hsl[2] < 0.1 || hsl[2] > 0.92) continue;
          var k = Math.floor(hsl[0] / 15) % 24;
          var peso = hsl[1] * (1 - Math.abs(hsl[2] - 0.5));
          var g = grupos[k] || (grupos[k] = { peso: 0, r: 0, g: 0, b: 0, n: 0 });
          g.peso += peso; g.r += rgb[0]; g.g += rgb[1]; g.b += rgb[2]; g.n++;
        }
        var mejor = null;
        Object.keys(grupos).forEach(function (k) { if (!mejor || grupos[k].peso > mejor.peso) mejor = grupos[k]; });
        // Menos de ~1 % de píxeles con color: el logo es en blanco y negro.
        if (!mejor || mejor.n < lado * lado * 0.01) return resolve(null);
        resolve(rgbAHex([mejor.r / mejor.n, mejor.g / mejor.n, mejor.b / mejor.n]));
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  /**
   * Paleta completa y legible a partir del color del logo: el principal se oscurece hasta que el texto
   * blanco sobre él tenga contraste 4,5:1 (AA); el resto son tintes del mismo tono. El color de los Bs
   * se aleja del tono del logo para que efectivo y bolívares nunca se confundan.
   */
  function paletaDesdeColor(hex) {
    var hsl = rgbAHsl(hexARgb(hex));
    var h = hsl[0], s = Math.max(0.45, Math.min(0.85, hsl[1])), l = Math.min(hsl[2], 0.5);
    var primario = hslAHex(h, s, l);
    while (contraste(primario, '#ffffff') < 4.5 && l > 0.08) { l -= 0.02; primario = hslAHex(h, s, l); }
    var azulado = h >= 190 && h <= 255;
    return {
      primario: primario,
      primarioOscuro: hslAHex(h, s, Math.max(0.06, l - 0.08)),
      primarioSuave: hslAHex(h, Math.min(s, 0.7), 0.92),
      fondo: hslAHex(h, 0.18, 0.965),
      tecla: hslAHex(h, 0.16, 0.935),
      teclaActiva: hslAHex(h, 0.2, 0.87),
      bs: azulado ? '#6d28d9' : '#1d4ed8',
      bsSuave: azulado ? '#ede9fe' : '#dbeafe'
    };
  }

  function coloresDeLogo(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);
    return colorDominante(dataUrl).then(function (hex) { return hex ? paletaDesdeColor(hex) : null; });
  }

  /** Muestras de la paleta bajo el logo. */
  function pintarPaleta(nodo, colores, sinColor) {
    nodo.innerHTML = '';
    nodo.hidden = !colores && !sinColor;
    if (!colores) {
      if (sinColor) nodo.textContent = 'Tu logo no tiene colores fuertes: Cuadre usará Verde Esmeralda.';
      return;
    }
    [['primario', 'Principal'], ['primarioSuave', 'Suave'], ['bs', 'Bolívares']].forEach(function (c) {
      var m = document.createElement('span');
      m.className = 'paleta-muestra';
      m.innerHTML = '<span class="paleta-color"></span><span></span>';
      m.firstChild.style.background = colores[c[0]];
      m.lastChild.textContent = c[1];
      nodo.appendChild(m);
    });
    var t = document.createElement('span');
    t.className = 'paleta-texto';
    t.textContent = 'Cuadre usará estos colores.';
    nodo.appendChild(t);
  }

  function pintarOpcionLogo() {
    var c = estado.comercio.colores;
    var visible = !!(c || coloresPendientes);
    el.temaLogoOpcion.hidden = !visible;
    if (visible) el.temaLogoMuestra.style.background = (coloresPendientes || c).primario;
  }

  /** Nombre y logo del comercio en la barra superior. */
  function pintarMarca() {
    var c = estado.comercio;
    poner(el.marcaNombre, c.nombre || 'Cuadre');
    if (c.logo) { el.marcaLogo.src = c.logo; el.marcaLogo.hidden = false; }
    else { el.marcaLogo.removeAttribute('src'); el.marcaLogo.hidden = true; }
    document.title = c.nombre ? c.nombre + ' · Cuadre' : 'Cuadre · Caja multimoneda';
  }

  function vistaLogo(dataUrl) {
    if (dataUrl) { el.ajusteLogoVista.src = dataUrl; el.ajusteLogoVista.hidden = false; }
    else { el.ajusteLogoVista.removeAttribute('src'); el.ajusteLogoVista.hidden = true; }
    el.ajusteLogoVacio.hidden = !!dataUrl;
    el.ajusteLogoQuitar.disabled = !dataUrl;
  }

  function mensajeAjustes(texto, ok) {
    el.ajustesMensaje.textContent = texto || '';
    el.ajustesMensaje.hidden = !texto;
    el.ajustesMensaje.setAttribute('data-tipo', ok ? 'ok' : 'error');
  }

  /** Reduce la imagen a 256 px como máximo y la devuelve en Base64 (PNG, conserva transparencia). */
  function procesarLogo(archivo) {
    return new Promise(function (resolve, reject) {
      if (!archivo || !/^image\//.test(archivo.type)) return reject(new Error('Elige un archivo de imagen.'));
      if (archivo.size > LOGO_MAX_BYTES) return reject(new Error('La imagen pesa más de 10 MB.'));
      var url = URL.createObjectURL(archivo);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var ancho = img.naturalWidth || LOGO_MAX_PX, alto = img.naturalHeight || LOGO_MAX_PX;
        var escala = Math.min(1, LOGO_MAX_PX / Math.max(ancho, alto));
        var lienzo = document.createElement('canvas');
        lienzo.width = Math.max(1, Math.round(ancho * escala));
        lienzo.height = Math.max(1, Math.round(alto * escala));
        lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
        resolve(lienzo.toDataURL('image/png'));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer esa imagen.'));
      };
      img.src = url;
    });
  }

  /** Llena el formulario de Ajustes con lo guardado. */
  function abrirAjustes() {
    if (!el.ajustes) return;
    var c = estado.comercio;
    coloresPendientes = null;
    pintarPaleta(el.ajustePaleta, null);
    pintarOpcionLogo();
    el.ajusteNombre.value = c.nombre || '';
    el.ajusteContacto.value = c.contacto || '';
    el.ajustePmBanco.value = c.pmBanco || '';
    el.ajustePmTelefono.value = c.pmTelefono || '';
    el.ajustePmDocumento.value = c.pmDocumento || '';
    el.ajusteLogo.value = '';
    logoPendiente = undefined;
    vistaLogo(c.logo);
    var tema = temaActual();
    Array.prototype.forEach.call(el.ajustesTemas, function (r) { r.checked = r.value === tema; });
    mensajeAjustes('');
    respaldoPendiente = null;
    mostrarConfirmacionRespaldo('');
    mensajeRespaldo('');
  }

  function elegirLogo() {
    var archivo = el.ajusteLogo.files && el.ajusteLogo.files[0];
    if (!archivo) return;
    mensajeAjustes('');
    procesarLogo(archivo).then(function (dataUrl) {
      logoPendiente = dataUrl;
      vistaLogo(dataUrl);
      return coloresDeLogo(dataUrl).then(function (colores) {
        coloresPendientes = colores;
        pintarPaleta(el.ajustePaleta, colores, !colores);
        pintarOpcionLogo();
        // Vista previa inmediata con los colores del logo; se guarda con "Guardar ajustes".
        if (colores) {
          aplicarTema('logo', colores);
          Array.prototype.forEach.call(el.ajustesTemas, function (r) { r.checked = r.value === 'logo'; });
        }
      });
    }).catch(function (e) {
      mensajeAjustes(e.message);
    }).then(function () {
      el.ajusteLogo.value = '';
    });
  }

  function quitarLogo() {
    logoPendiente = null;
    vistaLogo(null);
    coloresPendientes = null;
    pintarPaleta(el.ajustePaleta, null);
  }

  /** El tema se aplica y se guarda al tocarlo, sin esperar a "Guardar ajustes". */
  function elegirTema(e) {
    var tema = e.target.value;
    var cambios = { tema: tema };
    if (tema === 'logo') {
      if (!coloresPendientes && !estado.comercio.colores) return;
      if (coloresPendientes) cambios.colores = coloresPendientes;
    }
    aplicarTema(tema, cambios.colores);
    DB.guardarAjustes(cambios).then(function (a) {
      estado.comercio.tema = a.tema;
      estado.comercio.colores = a.colores;
    }).catch(function (err) {
      console.error(err);
      mensajeAjustes('No se pudo guardar el tema.');
    });
  }

  function guardarAjustes(e) {
    if (e) e.preventDefault();
    var cambios = {
      nombre: el.ajusteNombre.value, contacto: el.ajusteContacto.value,
      pmBanco: el.ajustePmBanco.value, pmTelefono: el.ajustePmTelefono.value, pmDocumento: el.ajustePmDocumento.value
    };
    if (logoPendiente !== undefined) cambios.logo = logoPendiente;
    if (coloresPendientes) cambios.colores = coloresPendientes;
    if (temaActual() === 'logo') cambios.tema = 'logo';
    var pin = el.ajustePin.value.trim();
    if (pin && !pinValido(pin)) { mensajeAjustes('El PIN tiene de 4 a 6 números.'); el.ajustePin.focus(); return; }
    el.ajustesGuardar.disabled = true;
    (pin ? datosPin(pin) : Promise.resolve(null)).then(function (p) {
      if (p) Object.assign(cambios, p);
      return DB.guardarAjustes(cambios);
    }).then(function (a) {
      el.ajustePin.value = '';
      estado.comercio = a;
      logoPendiente = undefined;
      coloresPendientes = null;
      pintarMarca();
      if (estado.recibo) mostrarRecibo(estado.recibo, true);
      mensajeAjustes('Ajustes guardados ✓', true);
    }).catch(function (err) {
      console.error(err);
      mensajeAjustes('No se pudieron guardar los ajustes. Intenta de nuevo.');
    }).then(function () {
      el.ajustesGuardar.disabled = false;
    });
  }

  // ---------- Entrada (teclado táctil) ----------
  function activarCampo(nombre) {
    estado.campoActivo = nombre;
    if (el.totalUsd) el.totalUsd.classList.toggle('campo-activo', nombre === 'total');
    if (el.recibidoUsd) el.recibidoUsd.classList.toggle('campo-activo', nombre === 'recibido');
  }

  /** Al empezar una venta nueva se oculta el recibo de la anterior. */
  function empezarEdicion() {
    if (estado.recibo) ocultarRecibo();
  }

  function teclear(tecla) {
    var campo = estado.campoActivo;
    var actual = estado.entrada[campo];

    if (tecla === 'limpiar') {
      ocultarRecibo();
      limpiarFormulario();
      return;
    }
    if (campo === 'total' && hayCarrito()) {
      avisar('El total sale de los productos. Toca «Quitar» para teclearlo a mano.');
      return;
    }
    empezarEdicion();
    if (tecla === 'borrar') {
      estado.entrada[campo] = actual.slice(0, -1);
    } else if (tecla === '.') {
      if (actual.indexOf('.') === -1) estado.entrada[campo] = (actual || '0') + '.';
    } else if (/^[0-9]$/.test(tecla)) {
      var partes = actual.split('.');
      if (partes.length === 2 && partes[1].length >= 2) return;           // máx. 2 decimales
      if (partes.length === 1 && partes[0].replace(/^0+/, '').length >= MAX_DIGITOS_ENTEROS) return;
      estado.entrada[campo] = (actual === '0' ? '' : actual) + tecla;
    } else {
      return;
    }
    recalcular();
  }

  /** Los billetes se suman al efectivo: $20 + $5 = $25. */
  function sumarBillete(monto) {
    var n = Number(monto);
    if (!isFinite(n) || n <= 0) return;
    empezarEdicion();
    var actual = aCentavos(estado.entrada.recibido) || 0;
    var nuevo = actual + Math.round(n * 100);
    if (nuevo >= Math.pow(10, MAX_DIGITOS_ENTEROS) * 100) return;
    estado.entrada.recibido = (nuevo % 100 === 0) ? String(nuevo / 100) : (nuevo / 100).toFixed(2);
    activarCampo('recibido');
    recalcular();
  }

  function limpiarFormulario() {
    estado.entrada.total = '';
    estado.entrada.recibido = '';
    estado.canalBs = 'pago-movil';
    estado.carrito = {};
    pintarCarrito();
    activarCampo('total');
    recalcular();
  }

  /** Texto tecleado con coma decimal para mostrar: "12.5" → "12,5". */
  function mostrarEntrada(texto) {
    return (texto || '0').replace('.', ',');
  }

  // ---------- Cálculo de pago mixto ----------
  /*
   * modo:
   *   'vuelto'   → el efectivo cubre el total: se entrega vuelto en USD.
   *   'restante' → falta dinero: el restante se cobra en Bs (Pago Móvil).
   *   'exacto'   → el efectivo es exactamente el total.
   */
  function calcular() {
    var total = aCentavos(estado.entrada.total);
    var efectivo = aCentavos(estado.entrada.recibido) || 0;
    var tasa = estado.tasa ? estado.tasa.valor : null;
    var r = {
      total: total, efectivo: efectivo, tasa: tasa,
      totalBs: null, modo: 'restante',
      vueltoUsd: 0, vueltoBs: 0, restanteUsd: 0, restanteBs: 0,
      aviso: '', valido: false
    };

    if (total === null || total === 0) {
      // Sin total no hay aviso: el campo vacío y el botón deshabilitado bastan (también tras cobrar).
      if (!tasa) r.aviso = 'Falta la tasa BCV del día.';
      return r;
    }

    var diferencia = efectivo - total;
    if (diferencia > 0) { r.modo = 'vuelto'; r.vueltoUsd = diferencia; }
    else if (diferencia === 0) { r.modo = 'exacto'; }
    else { r.modo = 'restante'; r.restanteUsd = -diferencia; }

    if (!tasa) {
      r.aviso = 'Falta la tasa BCV del día.';
      return r;
    }

    r.totalBs = aBsCentavos(total, tasa);
    r.vueltoBs = aBsCentavos(r.vueltoUsd, tasa);
    r.restanteBs = aBsCentavos(r.restanteUsd, tasa);
    r.valido = true;
    return r;
  }

  /** 'efectivo' | 'mixto' | 'pago-movil' | 'punto', según cómo se pagó. */
  function metodoDePago(r) {
    if (r.restanteUsd === 0) return 'efectivo';
    if (r.efectivo > 0) return 'mixto';
    return estado.canalBs === 'punto' ? 'punto' : 'pago-movil';
  }

  var NOMBRE_METODO = { efectivo: 'Efectivo USD', mixto: 'Pago mixto', 'pago-movil': 'Pago Móvil', punto: 'Punto de venta' };
  var NOMBRE_CANAL = { 'pago-movil': 'Pago Móvil', punto: 'Punto de venta' };

  function elegirCanal(canal) {
    if (!NOMBRE_CANAL[canal]) return;
    estado.canalBs = canal;
    recalcular();
  }

  function recalcular() {
    var r = calcular();
    poner(el.totalUsd, mostrarEntrada(estado.entrada.total));
    poner(el.recibidoUsd, mostrarEntrada(estado.entrada.recibido));
    poner(el.totalBs, r.totalBs !== null ? bs(r.totalBs) : '—');

    var titulo, principal, secundario;
    if (r.total === null || r.total === 0) {
      titulo = 'Restante a cobrar en Bs';
      principal = '—';
      secundario = '';
    } else if (r.modo === 'vuelto') {
      titulo = 'Vuelto a entregar en USD';
      principal = usd(r.vueltoUsd);
      secundario = r.tasa ? 'Equivale a ' + bs(r.vueltoBs) : '';
    } else if (r.modo === 'exacto') {
      titulo = 'Pago exacto en efectivo';
      principal = usd(0);
      secundario = 'Sin vuelto ni restante';
    } else {
      titulo = (r.efectivo > 0 ? 'Restante a cobrar en Bs · ' : 'Total a cobrar en Bs · ') + NOMBRE_CANAL[estado.canalBs];
      principal = r.tasa ? bs(r.restanteBs) : '—';
      secundario = 'Equivale a ' + usd(r.restanteUsd);
    }
    if (el.resultado) {
      el.resultado.setAttribute('data-modo', r.modo);
      el.resultado.toggleAttribute('data-vacio', r.total === null || r.total === 0);
    }
    poner(el.resultadoTitulo, titulo);
    poner(el.resultadoPrincipal, principal);
    poner(el.resultadoSecundario, secundario);

    if (el.canalBs) {
      el.canalBs.hidden = !(r.valido && r.modo === 'restante');
      Array.prototype.forEach.call(el.canalBs.querySelectorAll('[data-canal]'), function (b) {
        b.setAttribute('aria-checked', String(b.getAttribute('data-canal') === estado.canalBs));
      });
    }
    avisar(r.aviso);
    if (el.registrar) el.registrar.disabled = !r.valido || registrando;
    return r;
  }

  function avisar(texto) {
    if (!el.aviso) return;
    el.aviso.textContent = texto || '';
    el.aviso.hidden = !texto;
  }

  // ---------- Cobro y registro ----------
  var registrando = false;

  function cobrar() {
    var r = calcular();
    if (!r.valido || registrando) return;

    var venta = {
      fecha: new Date().toISOString(),
      totalUsd: r.total / 100,
      totalBs: r.totalBs / 100,
      efectivoUsd: r.efectivo / 100,
      recibidoUsd: r.efectivo / 100,
      vueltoUsd: r.vueltoUsd / 100,
      vueltoBs: r.vueltoBs / 100,
      restanteUsd: r.restanteUsd / 100,
      restanteBs: r.restanteBs / 100,
      metodo: metodoDePago(r),
      tasa: r.tasa
    };
    // Tasas de referencia vigentes, para el recibo (no intervienen en el cálculo).
    if (estado.tasasRef.eur) venta.tasaEur = estado.tasasRef.eur.valor;
    if (estado.tasasRef.paralelo) venta.tasaParalelo = estado.tasasRef.paralelo.valor;
    if (r.restanteBs > 0) venta.canalBs = estado.canalBs;
    if (hayCarrito()) venta.items = itemsCarrito();

    // Pago Móvil: primero la hoja con el monto exacto, los datos del comercio y la referencia.
    if (venta.canalBs === 'pago-movil') return abrirCobroPM(venta);
    guardarVenta(venta);
  }

  /** Registra la venta; con `refPago` (pago ya recibido por SMS) la deja verificada en el acto. */
  function guardarVenta(venta, refPago) {
    if (registrando) return Promise.resolve();
    registrando = true;
    if (el.registrar) el.registrar.disabled = true;
    return DB.registrarVenta(venta).then(function (id) {
      venta.id = id;
      if (!refPago) return venta;
      return DB.verificarVenta(id, { referencia: refPago }).catch(function (e) {
        console.warn(e); // la venta quedó registrada; solo queda por verificar
        return venta;
      });
    }).then(function (guardada) {
      limpiarFormulario();
      mostrarRecibo(Object.assign(venta, guardada));
      if (venta.items) refrescarCatalogo();
      return renderVentas();
    }).catch(function (e) {
      console.error(e);
      avisar('No se pudo registrar la venta. Intenta de nuevo.');
    }).then(function () {
      registrando = false;
      recalcular();
    });
  }

  // ---------- Cobro por Pago Móvil ----------
  var ventaPorCobrar = null;
  var pagoEncontrado = null; // pago recibido (SMS) que coincide con la referencia escrita

  function datosPagoMovil() {
    var c = estado.comercio;
    if (!c.pmBanco || !c.pmTelefono || !c.pmDocumento) return null;
    return [
      ['Banco', c.pmBanco + (PM.nombreBanco(c.pmBanco) ? ' · ' + PM.nombreBanco(c.pmBanco) : '')],
      ['Teléfono', c.pmTelefono],
      ['Cédula / RIF', c.pmDocumento]
    ];
  }

  function textoDatosPagoMovil(montoBs) {
    var t = encabezadoComercio('Datos para Pago Móvil').concat(['']);
    datosPagoMovil().forEach(function (l) { t.push(l[0] + ': ' + l[1]); });
    t.push('Monto: ' + bs(montoBs), '', 'Envíe el monto exacto, por favor. ¡Gracias!');
    return t.join('\n');
  }

  function llenarDl(dl, lineas) {
    dl.innerHTML = '';
    lineas.forEach(function (l) {
      var dt = document.createElement('dt');
      var dd = document.createElement('dd');
      dt.textContent = l[0];
      dd.textContent = l[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
  }

  function abrirCobroPM(venta) {
    if (!el.cobroPm) return guardarVenta(venta);
    ventaPorCobrar = venta;
    pagoEncontrado = null;
    var monto = cent(venta.restanteBs);
    poner(el.cobroPmMonto, bs(monto));
    poner(el.cobroPmEquivale, 'Equivale a ' + usd(cent(venta.restanteUsd)) + (venta.efectivoUsd > 0 ? ' · el resto se pagó en efectivo' : ''));
    var datos = datosPagoMovil();
    el.cobroPmDatos.hidden = !datos;
    el.cobroPmBotones.hidden = !datos;
    el.cobroPmSinDatos.hidden = !!datos;
    if (datos) {
      llenarDl(el.cobroPmDatos, datos);
      el.cobroPmWhatsapp.href = 'https://wa.me/?text=' + encodeURIComponent(textoDatosPagoMovil(monto));
      poner(el.cobroPmCopiar, 'Copiar datos');
    }
    el.cobroPmRef.value = '';
    estadoPago(el.cobroPmEstado, '');
    el.cobroPmRegistrar.disabled = false;
    if (!el.cobroPm.open) el.cobroPm.showModal();
    el.cobroPmCerrar.focus();
    cargarPagos().then(evaluarRefCobro);
  }

  function cargarPagos() {
    return DB.pagosRecibidos().then(function (lista) { estado.pagos = lista; }, function (e) {
      console.error(e);
      estado.pagos = [];
    });
  }

  /** Mensaje de estado del pago: tipo 'ok' | 'aviso' | 'error' | 'info'. */
  function estadoPago(nodo, texto, tipo) {
    nodo.textContent = texto || '';
    nodo.hidden = !texto;
    nodo.setAttribute('data-tipo', tipo || 'info');
  }

  /** Busca entre los SMS ya recibidos el pago que corresponde a la referencia escrita. */
  function evaluarRefCobro() {
    if (!ventaPorCobrar) return;
    pagoEncontrado = null;
    var ref = PM.limpiarRef(el.cobroPmRef.value);
    var monto = cent(ventaPorCobrar.restanteBs);
    if (!ref) return estadoPago(el.cobroPmEstado, 'Sin referencia, la venta quedará por verificar.');
    if (ref.length < 4) return estadoPago(el.cobroPmEstado, 'Escribe al menos 4 dígitos de la referencia.');
    var coinciden = (estado.pagos || []).filter(function (p) { return PM.coincideRef(ref, p.referencia); });
    var libres = coinciden.filter(function (p) { return p.ventaId == null; });
    var exactos = libres.filter(function (p) { return cent(p.montoBs) === monto; });
    if (exactos.length === 1) {
      pagoEncontrado = exactos[0];
      return estadoPago(el.cobroPmEstado, '✓ Pago recibido: ' + bs(monto) + ' · Ref. ' + pagoEncontrado.referencia +
        '. La venta quedará verificada.', 'ok');
    }
    if (libres.length) {
      return estadoPago(el.cobroPmEstado, 'Llegó un pago con esa referencia, pero por ' + bs(cent(libres[0].montoBs)) +
        ', no por ' + bs(monto) + '. La venta quedará por verificar.', 'error');
    }
    if (coinciden.length) {
      return estadoPago(el.cobroPmEstado, '⚠ Esa referencia ya verificó otra venta. Puede ser una captura repetida: revisa tu banco.', 'error');
    }
    estadoPago(el.cobroPmEstado, 'Aún no tengo el SMS de este pago. La venta quedará por verificar y se verifica sola al compartir el SMS.', 'aviso');
  }

  function registrarCobroPM(e) {
    if (e) e.preventDefault();
    if (!ventaPorCobrar) return;
    var venta = ventaPorCobrar;
    var ref = PM.limpiarRef(el.cobroPmRef.value);
    if (ref) venta.referencia = ref;
    var refPago = pagoEncontrado ? pagoEncontrado.referencia : null;
    el.cobroPmRegistrar.disabled = true;
    ventaPorCobrar = null;
    el.cobroPm.close();
    guardarVenta(venta, refPago);
  }

  function copiarDatosPM() {
    var datos = ventaPorCobrar && datosPagoMovil();
    if (!datos) return;
    var texto = textoDatosPagoMovil(cent(ventaPorCobrar.restanteBs));
    var hecho = function () { poner(el.cobroPmCopiar, '¡Copiado!'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(hecho, function () { poner(el.cobroPmCopiar, 'No se pudo copiar'); });
    } else {
      poner(el.cobroPmCopiar, 'No se pudo copiar');
    }
  }

  // ---------- Verificar Pago Móvil (SMS del banco) ----------
  var ventaAVerificar = null; // venta elegida en la lista; null = buscar entre todas las pendientes
  var verificando = false;

  /** Ventas abiertas, válidas y con Pago Móvil sin verificar. */
  function pendientesDe(ventas) {
    return ventas.filter(function (v) { return !v.anuladaEn && v.cierreId == null && desglose(v).porVerificar; });
  }

  function abrirVerificar(opciones) {
    if (!el.verificar) return;
    var o = opciones || {};
    ventaAVerificar = null;
    el.verificarTexto.value = o.texto || '';
    estadoPago(el.verificarResultado, '');
    pintarOpciones([]);
    el.verificarPegar.hidden = !(navigator.clipboard && navigator.clipboard.readText);
    if (!el.verificar.open) el.verificar.showModal();
    return Promise.all([DB.ventasAbiertas(), cargarPagos()]).then(function (res) {
      var ventas = res[0];
      if (o.ventaId != null) ventaAVerificar = ventas.filter(function (v) { return v.id === Number(o.ventaId); })[0] || null;
      pintarVerificar(ventas);
      if (o.texto) return procesarSMS();
      if (ventaAVerificar) el.verificarTexto.focus(); else el.verificarCerrar.focus();
    }).catch(function (e) {
      console.error(e);
      estadoPago(el.verificarResultado, 'No se pudieron leer las ventas.', 'error');
    });
  }

  function lineasVenta(v) {
    var d = desglose(v);
    var l = [
      ['Hora', fmtFechaRecibo.format(new Date(v.fecha))],
      ['Pago Móvil', bs(d.restanteBs)]
    ];
    if (v.referencia) l.push(['Referencia', v.referencia]);
    return l;
  }

  function pintarVerificar(ventas) {
    var v = ventaAVerificar;
    el.verificarVenta.hidden = !v;
    el.verificarManual.hidden = !(v && desglose(v).porVerificar);
    if (v) llenarDl(el.verificarVenta, lineasVenta(v));
    var pendientes = v ? [] : pendientesDe(ventas);
    el.verificarPendientes.hidden = !pendientes.length;
    el.verificarLista.innerHTML = '';
    pendientes.slice().reverse().forEach(function (p) {
      var d = desglose(p);
      var li = document.createElement('li');
      li.className = 'venta';
      li.innerHTML = '<span class="venta-hora"></span><span class="venta-total"></span><span class="venta-detalle"></span>';
      li.children[0].textContent = fmtHora.format(new Date(p.fecha));
      li.children[1].textContent = bs(d.restanteBs);
      li.children[2].textContent = p.referencia ? 'Ref. ' + p.referencia : 'Sin referencia';
      el.verificarLista.appendChild(li);
    });
  }

  /** Botones para elegir a qué venta aplicar un pago cuando no hay una coincidencia exacta. */
  function pintarOpciones(opciones, pago) {
    el.verificarOpciones.innerHTML = '';
    el.verificarOpciones.hidden = !opciones.length;
    opciones.forEach(function (v) {
      var d = desglose(v);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'boton boton-terciario';
      b.setAttribute('data-verificar-venta', String(v.id));
      b.setAttribute('data-verificar-ref', pago.referencia);
      b.textContent = 'Verificar la venta de las ' + fmtHora.format(new Date(v.fecha)) + ' (' + bs(d.restanteBs) + ')';
      el.verificarOpciones.appendChild(b);
    });
  }

  function verificarYMostrar(id, refPago) {
    if (verificando) return Promise.resolve();
    verificando = true;
    return DB.verificarVenta(id, refPago ? { referencia: refPago } : { via: 'manual' }).then(function (v) {
      pintarOpciones([]);
      estadoPago(el.verificarResultado, '✓ Verificada la venta de las ' + fmtHora.format(new Date(v.fecha)) + ' por ' +
        bs(desglose(v).restanteBs) + (refPago ? ' · Ref. ' + refPago : ' (revisada en el banco)') + '.', 'ok');
      if (estado.recibo && estado.recibo.id === v.id) mostrarRecibo(v, true);
      if (ventaAVerificar && ventaAVerificar.id === v.id) ventaAVerificar = v;
      return Promise.all([renderVentas(), DB.ventasAbiertas()]).then(function (res) { pintarVerificar(res[1]); });
    }).catch(function (e) {
      console.error(e);
      estadoPago(el.verificarResultado, e && e.message ? e.message : 'No se pudo verificar. Intenta de nuevo.', 'error');
    }).then(function () {
      verificando = false;
    });
  }

  /** Lee el SMS, lo guarda como pago recibido y lo empareja con la venta que corresponde. */
  function procesarSMS() {
    pintarOpciones([]);
    var p = PM.parsear(el.verificarTexto.value);
    if (!el.verificarTexto.value.trim()) return estadoPago(el.verificarResultado, 'Pega o comparte el mensaje del banco.', 'aviso');
    if (p.enviado) return estadoPago(el.verificarResultado, 'Este mensaje parece de un pago que TÚ enviaste, no de uno recibido.', 'error');
    if (!p.montoBs || !p.referencia) {
      var falta = !p.montoBs && !p.referencia ? 'el monto ni la referencia' : (!p.montoBs ? 'el monto' : 'la referencia');
      return estadoPago(el.verificarResultado, 'No encontré ' + falta + ' en el mensaje. ¿Es el SMS de tu banco? ' +
        (ventaAVerificar ? 'Si ya lo viste en tu banco, puedes marcarla verificada a mano.' : ''), 'error');
    }
    var res;
    return DB.guardarPagoRecibido({ referencia: p.referencia, montoBs: p.montoBs / 100, banco: p.banco, texto: el.verificarTexto.value })
      .then(function (r) {
        res = r;
        return DB.ventasAbiertas();
      }).then(function (ventas) {
        var pago = res.pago;
        var monto = cent(pago.montoBs);
        var datosPago = bs(monto) + ' · Ref. ' + pago.referencia + (pago.banco ? ' · ' + pago.banco : '');
        var vObjetivo = ventaAVerificar;
        if (pago.ventaId != null && !(vObjetivo && vObjetivo.id === pago.ventaId)) {
          return estadoPago(el.verificarResultado, '⚠ Este pago (' + datosPago + ') ya verificó otra venta. ' +
            'Puede ser un SMS repetido o una captura reutilizada.', 'error');
        }
        var igual = function (v) { return desglose(v).restanteBs === monto; };
        if (vObjetivo) {
          if (!desglose(vObjetivo).porVerificar) return estadoPago(el.verificarResultado, 'Esta venta ya está verificada.', 'ok');
          if (vObjetivo.referencia && !PM.coincideRef(vObjetivo.referencia, pago.referencia)) {
            estadoPago(el.verificarResultado, 'La referencia del SMS (' + pago.referencia + ') no es la de esta venta (' +
              vObjetivo.referencia + '). Guardé el pago por si es de otra venta.', 'error');
            return pintarOpciones([vObjetivo], pago);
          }
          if (igual(vObjetivo)) return verificarYMostrar(vObjetivo.id, pago.referencia);
          estadoPago(el.verificarResultado, 'El SMS es por ' + bs(monto) + ' y la venta por ' + bs(desglose(vObjetivo).restanteBs) +
            '. Si aceptas la diferencia, verifícala igual.', 'error');
          return pintarOpciones([vObjetivo], pago);
        }
        var pendientes = pendientesDe(ventas);
        var porRef = pendientes.filter(function (v) { return v.referencia && PM.coincideRef(v.referencia, pago.referencia); });
        var exactas = porRef.filter(igual);
        if (exactas.length === 1) return verificarYMostrar(exactas[0].id, pago.referencia);
        if (porRef.length) {
          estadoPago(el.verificarResultado, 'Hay una venta con esa referencia, pero el monto no cuadra: el SMS es por ' + bs(monto) + '.', 'error');
          return pintarOpciones(porRef, pago);
        }
        var sinRef = pendientes.filter(function (v) { return !v.referencia && igual(v); });
        if (sinRef.length === 1) return verificarYMostrar(sinRef[0].id, pago.referencia);
        if (sinRef.length > 1) {
          estadoPago(el.verificarResultado, 'Hay ' + sinRef.length + ' ventas por ' + bs(monto) + ' sin referencia. ¿A cuál corresponde?', 'aviso');
          return pintarOpciones(sinRef, pago);
        }
        estadoPago(el.verificarResultado, (res.nuevo ? 'Guardé este pago (' : 'Este pago ya estaba guardado (') + datosPago +
          '). Cuando cobres con esa referencia, la venta quedará verificada sola.', 'aviso');
      }).catch(function (e) {
        console.error(e);
        estadoPago(el.verificarResultado, 'No se pudo guardar el pago. Intenta de nuevo.', 'error');
      });
  }

  function pegarSMS() {
    navigator.clipboard.readText().then(function (texto) {
      el.verificarTexto.value = texto || '';
      if (texto) procesarSMS();
    }, function () {
      estadoPago(el.verificarResultado, 'No pude leer el portapapeles. Mantén presionado el cuadro y elige «Pegar».', 'aviso');
    });
  }

  /** Texto compartido a Cuadre desde otra app (Web Share Target del manifest): abre la verificación. */
  function revisarCompartido() {
    var q = new URLSearchParams(location.search);
    var texto = [q.get('titulo'), q.get('texto'), q.get('enlace')].filter(Boolean).join(' ').trim();
    if (!q.has('texto') && !q.has('titulo')) return;
    if (history.replaceState) history.replaceState(null, '', location.pathname);
    if (texto) abrirVerificar({ texto: texto });
  }

  // ---------- Recibo Exprés ----------
  /** Centavos de un campo guardado en decimales (0 si falta, para ventas antiguas). */
  function cent(valor) { return Math.round((Number(valor) || 0) * 100); }

  /** Normaliza una venta (nueva o antigua) a centavos. */
  function desglose(v) {
    var totalUsd = cent(v.totalUsd);
    var efectivo = cent(v.efectivoUsd != null ? v.efectivoUsd : v.recibidoUsd);
    return {
      totalUsd: totalUsd,
      totalBs: v.totalBs != null ? cent(v.totalBs) : aBsCentavos(totalUsd, v.tasa),
      efectivo: efectivo,
      vueltoUsd: Math.max(0, cent(v.vueltoUsd)),
      vueltoBs: Math.max(0, cent(v.vueltoBs)),
      restanteUsd: cent(v.restanteUsd),
      restanteBs: cent(v.restanteBs),
      metodo: v.metodo || 'efectivo',
      // Las ventas anteriores a Punto de venta no tienen canalBs: sus Bs cuentan como Pago Móvil.
      canal: v.canalBs || (v.metodo === 'punto' ? 'punto' : 'pago-movil'),
      // Solo las ventas nuevas (con canalBs) se piden verificar.
      porVerificar: v.canalBs === 'pago-movil' && cent(v.restanteBs) > 0 && !v.verificadaEn
    };
  }

  /** Líneas [etiqueta, valor] del resumen, compartidas por la pantalla y WhatsApp. */
  function lineasRecibo(v) {
    var d = desglose(v);
    var lineas = [['Fecha', fmtFechaRecibo.format(new Date(v.fecha))]];
    (v.items || []).forEach(function (it) {
      lineas.push([fmtCantidad(it.cantidad) + ' × ' + it.nombre, usd(Math.round(cent(it.precioUsd) * it.cantidad))]);
    });
    lineas.push(
      ['Total USD', usd(d.totalUsd)],
      ['Tasa BCV', 'Bs ' + fmtTasa.format(v.tasa) + ' por USD']
    );
    if (v.tasaEur) lineas.push(['Tasa EUR', 'Bs ' + fmtTasa.format(v.tasaEur) + ' por EUR']);
    if (v.tasaParalelo) lineas.push(['Tasa Binance', 'Bs ' + fmtTasa.format(v.tasaParalelo) + ' por USDT']);
    lineas.push(['Total en Bs', bs(d.totalBs)]);
    if (d.efectivo > 0) lineas.push(['Pagado en USD (efectivo)', usd(d.efectivo)]);
    if (d.restanteBs > 0) lineas.push(['Pagado en Bs (' + NOMBRE_CANAL[d.canal] + ')', bs(d.restanteBs)]);
    if (d.restanteBs > 0 && d.canal === 'pago-movil' && (v.refBanco || v.referencia)) lineas.push(['Referencia', v.refBanco || v.referencia]);
    if (d.vueltoUsd > 0) lineas.push(['Vuelto entregado', usd(d.vueltoUsd)]);
    return lineas;
  }

  /** Encabezado del comercio para los mensajes de WhatsApp (nombre en negrita y RIF/teléfono). */
  function encabezadoComercio(titulo) {
    var c = estado.comercio;
    if (!c.nombre && !c.contacto) return ['*' + titulo + ' · Cuadre*'];
    var t = [];
    if (c.nombre) t.push('*' + c.nombre + '*');
    if (c.contacto) t.push(c.contacto);
    t.push('', '*' + titulo + '*');
    return t;
  }

  function mensajeWhatsApp(v) {
    var texto = encabezadoComercio('Recibo').concat(['']);
    lineasRecibo(v).forEach(function (l) { texto.push(l[0] + ': ' + l[1]); });
    texto.push('', '¡Gracias por su compra!');
    return texto.join('\n');
  }

  function enlaceWhatsApp(v) {
    return 'https://wa.me/?text=' + encodeURIComponent(mensajeWhatsApp(v));
  }

  function pintarComercioRecibo() {
    var c = estado.comercio;
    el.reciboComercio.hidden = !(c.nombre || c.contacto || c.logo);
    poner(el.reciboNombre, c.nombre || '');
    poner(el.reciboContacto, c.contacto || '');
    if (c.logo) { el.reciboLogo.src = c.logo; el.reciboLogo.hidden = false; }
    else { el.reciboLogo.removeAttribute('src'); el.reciboLogo.hidden = true; }
  }

  /** `sinDesplazar` evita mover la pantalla cuando solo se refresca (p. ej. tras cambiar los ajustes). */
  function mostrarRecibo(v, sinDesplazar) {
    estado.recibo = v;
    if (!el.recibo) return;
    pintarComercioRecibo();
    var lineas = lineasRecibo(v);
    // El estado de verificación es para el comerciante: va en pantalla, no en el WhatsApp del cliente.
    if (v.canalBs === 'pago-movil' && cent(v.restanteBs) > 0) lineas.push(['Pago Móvil', v.verificadaEn ? 'Verificado ✓' : 'Por verificar']);
    llenarDl(el.reciboDetalle, lineas);
    el.reciboVerificar.hidden = !desglose(v).porVerificar;
    var metodo = desglose(v).metodo;
    poner(el.reciboMetodo, NOMBRE_METODO[metodo] || '');
    el.reciboMetodo.setAttribute('data-metodo', metodo);
    el.whatsapp.href = enlaceWhatsApp(v);
    if (el.factura && (!estado.facturaDe || estado.facturaDe !== v.id)) {
      estado.facturaDe = v.id;
      el.factura.hidden = false;
      el.facturaCorreo.value = v.correo || '';
      mensajeFactura('');
    }
    actualizarConexion();
    el.recibo.hidden = false;
    // En teléfono, lleva el recibo a la vista para que el botón de WhatsApp quede a mano.
    if (!sinDesplazar && el.recibo.scrollIntoView) el.recibo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- Factura PDF ----------
  function mensajeFactura(texto) {
    if (!el.facturaMensaje) return;
    el.facturaMensaje.textContent = texto || '';
    el.facturaMensaje.hidden = !texto;
  }

  function numeroFactura(v) { return ('000000' + v.id).slice(-6); }

  /** Lo que lleva la factura de una venta, ya en texto. */
  function datosFactura(v, correo) {
    var d = desglose(v), c = estado.comercio;
    var css = getComputedStyle(document.documentElement);
    var colores = c.tema === 'logo' && c.colores ? c.colores : null;
    var items = (v.items || []).map(function (it) {
      return {
        nombre: it.nombre, cantidad: fmtCantidad(it.cantidad), precio: usd(cent(it.precioUsd)),
        importe: usd(Math.round(cent(it.precioUsd) * it.cantidad))
      };
    });
    if (!items.length) items.push({ nombre: 'Venta', cantidad: '1', precio: usd(d.totalUsd), importe: usd(d.totalUsd) });
    var pagos = [];
    if (d.efectivo > 0) pagos.push(['Efectivo USD', usd(d.efectivo)]);
    if (d.restanteBs > 0) pagos.push([NOMBRE_CANAL[d.canal], bs(d.restanteBs)]);
    if (d.restanteBs > 0 && d.canal === 'pago-movil' && (v.refBanco || v.referencia)) pagos.push(['Referencia', v.refBanco || v.referencia]);
    if (d.vueltoUsd > 0) pagos.push(['Vuelto entregado', usd(d.vueltoUsd)]);
    return {
      numero: numeroFactura(v),
      fecha: fmtFechaRecibo.format(new Date(v.fecha)),
      cliente: correo || '',
      comercio: {
        nombre: c.nombre, contacto: c.contacto, logo: c.logo,
        color: (colores && colores.primario) || css.getPropertyValue('--primario').trim() || '#047857',
        colorSuave: (colores && colores.primarioSuave) || css.getPropertyValue('--primario-suave').trim() || '#d1fae5'
      },
      items: items,
      totales: [
        ['Tasa BCV', 'Bs ' + fmtTasa.format(v.tasa) + ' por USD'],
        ['Total en Bs', bs(d.totalBs)],
        ['Total USD', usd(d.totalUsd), true]
      ],
      pagos: pagos,
      pie: 'Documento sin validez fiscal · Hecho con Cuadre'
    };
  }

  function pdfFactura(v, correo) {
    if (!window.CuadreFactura) return Promise.reject(new Error('Sin generador de PDF'));
    return window.CuadreFactura.crear(datosFactura(v, correo)).then(function (blob) {
      var nombre = 'Factura-' + numeroFactura(v) + '.pdf';
      try { return new File([blob], nombre, { type: 'application/pdf' }); } catch (e) { blob.name = nombre; return blob; }
    });
  }

  function verFactura() {
    var v = estado.recibo;
    if (!v) return;
    // La ventana se abre antes de armar el PDF para que el navegador no la bloquee.
    var ventana = window.open('', '_blank');
    pdfFactura(v, el.facturaCorreo.value.trim()).then(function (archivo) {
      var url = URL.createObjectURL(archivo);
      if (ventana) ventana.location.href = url; else descargar(archivo);
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) {
      if (ventana) ventana.close();
      console.error(e);
      mensajeFactura('No se pudo crear el PDF. Intenta de nuevo.');
    });
  }

  function correoValido(t) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t); }

  /**
   * Sin servidor no se puede mandar el correo directamente: se abre la app de correo del teléfono
   * con el PDF adjunto (menú de compartir). El correo del cliente queda copiado para pegarlo en «Para».
   * Donde no se puede compartir archivos, se descarga el PDF y se abre un correo ya dirigido al cliente.
   */
  function enviarFactura() {
    var v = estado.recibo;
    if (!v) return;
    var correo = el.facturaCorreo.value.trim();
    if (!correoValido(correo)) {
      el.facturaCorreo.setAttribute('aria-invalid', 'true');
      el.facturaCorreo.focus();
      mensajeFactura('Escribe el correo del cliente, por ejemplo cliente@gmail.com.');
      return;
    }
    el.facturaCorreo.removeAttribute('aria-invalid');
    var c = estado.comercio;
    var asunto = 'Factura N.º ' + numeroFactura(v) + (c.nombre ? ' · ' + c.nombre : '');
    var cuerpo = 'Hola, adjuntamos la factura de su compra por ' + usd(desglose(v).totalUsd) + '. ¡Gracias por su compra!';
    el.facturaEnviar.disabled = true;
    pdfFactura(v, correo).then(function (archivo) {
      DB.anotarCorreo(v.id, correo).then(function () { v.correo = correo; }, function (e) { console.warn(e); });
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [archivo] })) {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(correo).catch(function () {});
        mensajeFactura('Elige tu app de correo. El correo del cliente quedó copiado: pégalo en «Para».');
        return navigator.share({ files: [archivo], title: asunto, text: cuerpo }).then(function () {
          mensajeFactura('Factura lista en tu app de correo para ' + correo + '.');
        }, function (e) {
          if (e && e.name === 'AbortError') mensajeFactura('No se envió. Puedes intentarlo de nuevo.');
          else throw e;
        });
      }
      descargar(archivo);
      location.href = 'mailto:' + encodeURIComponent(correo) + '?subject=' + encodeURIComponent(asunto) +
        '&body=' + encodeURIComponent(cuerpo);
      mensajeFactura('Se descargó el PDF y se abrió un correo para ' + correo + ': adjunta el PDF antes de enviar.');
    }).catch(function (e) {
      console.error(e);
      mensajeFactura('No se pudo preparar la factura. Intenta de nuevo.');
    }).then(function () {
      el.facturaEnviar.disabled = false;
    });
  }

  function omitirFactura() {
    el.factura.hidden = true;
    mensajeFactura('');
  }

  function ocultarRecibo() {
    estado.recibo = null;
    if (el.recibo) el.recibo.hidden = true;
  }

  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }

  /** "Efectivo $10,00 · Pago Móvil Bs 50,00 · Vuelto $1,00" */
  function detalleVenta(d) {
    var partes = [];
    if (d.efectivo > 0) partes.push('Efectivo ' + usd(d.efectivo));
    if (d.restanteBs > 0) partes.push((d.canal === 'punto' ? 'Punto ' : 'Pago Móvil ') + bs(d.restanteBs));
    if (d.vueltoUsd > 0) partes.push('Vuelto ' + usd(d.vueltoUsd));
    return partes.join(' · ');
  }

  // ---------- Ventas del día ----------
  function renderVentas() {
    return DB.ventasDelDia().then(function (todas) {
      // Las ventas archivadas por un cierre ya no cuentan en la caja del turno.
      var ventas = todas.filter(function (v) { return v.cierreId == null; });
      // Las anuladas siguen en la lista (tachadas) pero no suman.
      var validas = ventas.filter(function (v) { return !v.anuladaEn; });
      var totalCent = 0;
      var totalBsCent = 0;

      if (el.ventasLista) {
        el.ventasLista.innerHTML = '';
        // Más recientes primero
        ventas.slice().reverse().forEach(function (v) {
          var d = desglose(v);
          var li = document.createElement('li');
          li.className = 'venta' + (v.anuladaEn ? ' venta-anulada' : '');
          li.innerHTML =
            '<span class="venta-hora"></span>' +
            '<span class="venta-total"></span>' +
            '<span class="venta-accion"></span>' +
            '<span class="venta-detalle"></span>';
          li.children[0].textContent = fmtHora.format(new Date(v.fecha));
          li.children[1].textContent = usd(d.totalUsd) + ' · ' + bs(d.totalBs);
          var estadoPm = null; // estado del Pago Móvil, va junto al detalle del pago
          if (v.anuladaEn) {
            var insignia = document.createElement('span');
            insignia.className = 'insignia-anulada';
            insignia.innerHTML = 'Anulada<small></small>';
            insignia.lastChild.textContent = fmtHora.format(new Date(v.anuladaEn));
            li.children[2].appendChild(insignia);
          } else {
            if (d.porVerificar) {
              var verif = document.createElement('button');
              verif.type = 'button';
              verif.className = 'boton boton-verificar';
              verif.setAttribute('data-verificar', String(v.id));
              verif.setAttribute('aria-label', 'Verificar el Pago Móvil de las ' + fmtHora.format(new Date(v.fecha)));
              verif.textContent = 'Por verificar';
              estadoPm = verif;
            } else if (v.verificadaEn && d.restanteBs > 0) {
              estadoPm = document.createElement('span');
              estadoPm.className = 'insignia-verificada';
              estadoPm.textContent = '✓ Verificado';
            }
            var boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'boton boton-anular';
            boton.setAttribute('data-anular', String(v.id));
            boton.setAttribute('aria-label', 'Anular la venta de las ' + fmtHora.format(new Date(v.fecha)) + ' por ' + usd(d.totalUsd));
            boton.textContent = 'Anular';
            li.children[2].appendChild(boton);
          }
          li.children[3].textContent = (v.items && v.items.length ? resumenItems(v.items) + ' · ' : '') + detalleVenta(d);
          if (estadoPm) { li.children[3].appendChild(document.createTextNode(' ')); li.children[3].appendChild(estadoPm); }
          el.ventasLista.appendChild(li);
        });
        if (!ventas.length) {
          var vacio = document.createElement('li');
          vacio.className = 'venta-vacia';
          vacio.textContent = 'Aún no hay ventas hoy.';
          el.ventasLista.appendChild(vacio);
        }
      }

      validas.forEach(function (v) {
        var d = desglose(v);
        totalCent += d.totalUsd;
        totalBsCent += d.totalBs; // Bs a la tasa de cada venta
      });

      var pendientes = pendientesDe(ventas).length;
      if (el.abrirVerificar) {
        poner(el.abrirVerificar, pendientes ? 'Verificar (' + pendientes + ')' : 'Verificar pagos');
        el.abrirVerificar.toggleAttribute('data-pendientes', pendientes > 0);
      }

      var anuladas = ventas.length - validas.length;
      poner(el.ventasResumen, plural(validas.length, 'venta', 'ventas') +
        ' · ' + usd(totalCent) + ' · ' + bs(totalBsCent) +
        (anuladas ? ' · ' + plural(anuladas, 'anulada', 'anuladas') : ''));
    }).catch(function (e) {
      console.error(e);
      poner(el.ventasResumen, 'No se pudieron cargar las ventas.');
    });
  }

  // ---------- Anular ventas ----------
  var ventaPorAnular = null;
  var anulando = false;

  function mensajeAnular(texto) {
    el.anularMensaje.textContent = texto || '';
    el.anularMensaje.hidden = !texto;
  }

  /** Abre la confirmación con el detalle de la venta. Solo se anulan ventas abiertas. */
  function pedirAnulacion(id) {
    if (!el.anular) return;
    DB.ventasAbiertas().then(function (ventas) {
      var v = ventas.filter(function (x) { return x.id === Number(id); })[0];
      if (!v || v.anuladaEn) return renderVentas();
      ventaPorAnular = v;
      var d = desglose(v);
      el.anularDetalle.innerHTML = '';
      [
        ['Hora', fmtFechaRecibo.format(new Date(v.fecha))],
        ['Total', usd(d.totalUsd) + ' · ' + bs(d.totalBs)],
        ['Pago', detalleVenta(d) || NOMBRE_METODO[d.metodo]]
      ].forEach(function (l) {
        var dt = document.createElement('dt');
        var dd = document.createElement('dd');
        dt.textContent = l[0];
        dd.textContent = l[1];
        el.anularDetalle.appendChild(dt);
        el.anularDetalle.appendChild(dd);
      });
      if (v.verificadaEn) {
        mensajeAnular('Este Pago Móvil ya está verificado: el dinero llegó a tu banco. Si anulas, devuélvelo al cliente.');
      }
      if (!v.verificadaEn) mensajeAnular('');
      el.anularConfirmar.disabled = false;
      if (!el.anular.open) el.anular.showModal();
      el.anularCancelar.focus();
    }).catch(function (e) {
      console.error(e);
      avisar('No se pudo leer la venta.');
    });
  }

  function confirmarAnulacion() {
    if (!ventaPorAnular || anulando) return;
    anulando = true;
    el.anularConfirmar.disabled = true;
    var id = ventaPorAnular.id;
    DB.anularVenta(id).then(function () {
      // Si el recibo en pantalla es el de esta venta, se oculta: ya no vale.
      if (estado.recibo && estado.recibo.id === id) ocultarRecibo();
      ventaPorAnular = null;
      el.anular.close();
      refrescarCatalogo();
      return renderVentas();
    }).catch(function (e) {
      console.error(e);
      mensajeAnular(e && e.message ? e.message : 'No se pudo anular. Intenta de nuevo.');
    }).then(function () {
      anulando = false;
      el.anularConfirmar.disabled = false;
    });
  }

  // ---------- Cierre de Caja ----------
  var cierreActual = null; // { ventas, resumen } mostrado en el modal
  var fmtDia = new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  /** 'YYYY-MM-DD' → '02/10/2026' (fecha local, sin desfase UTC). */
  function diaLegible(dia) {
    var p = String(dia).split('-');
    return fmtDia.format(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  }

  /**
   * Totales del cierre en centavos. Efectivo en caja = efectivo recibido − vuelto entregado.
   * Las ventas anuladas no suman: solo se cuentan en `anuladas` (y se archivan igual).
   * `diasAnteriores` = ventas válidas de días previos a hoy que siguen sin cerrar.
   */
  function resumirCierre(ventas) {
    var hoy = DB ? DB.diaLocal() : '';
    var r = {
      cantidad: 0, anuladas: 0, diasAnteriores: 0,
      metodos: { efectivo: 0, mixto: 0, 'pago-movil': 0, punto: 0 },
      recibidoUsd: 0, vueltoUsd: 0, efectivoUsd: 0,
      bancoBs: 0, bancoUsd: 0, pagoMovilBs: 0, puntoBs: 0, porVerificar: 0, porVerificarBs: 0,
      totalUsd: 0, totalBs: 0,
      desde: null, hasta: null
    };
    ventas.forEach(function (v) {
      if (!r.desde || v.dia < r.desde) r.desde = v.dia;
      if (!r.hasta || v.dia > r.hasta) r.hasta = v.dia;
      if (v.anuladaEn) { r.anuladas++; return; }
      r.cantidad++;
      if (v.dia < hoy) r.diasAnteriores++;
      var d = desglose(v);
      r.metodos[d.metodo] = (r.metodos[d.metodo] || 0) + 1;
      r.recibidoUsd += d.efectivo;
      r.vueltoUsd += d.vueltoUsd;
      r.bancoBs += d.restanteBs;
      r.bancoUsd += d.restanteUsd;
      if (d.canal === 'punto') r.puntoBs += d.restanteBs; else r.pagoMovilBs += d.restanteBs;
      if (d.porVerificar) { r.porVerificar++; r.porVerificarBs += d.restanteBs; }
      r.totalUsd += d.totalUsd;
      r.totalBs += d.totalBs;
    });
    r.efectivoUsd = r.recibidoUsd - r.vueltoUsd;
    return r;
  }

  function textoPeriodo(r) {
    if (!r.desde) return diaLegible(DB.diaLocal());
    return r.desde === r.hasta ? diaLegible(r.desde) : diaLegible(r.desde) + ' al ' + diaLegible(r.hasta);
  }

  function textoMetodos(r) {
    var partes = [];
    if (r.metodos.efectivo) partes.push(r.metodos.efectivo + ' efectivo');
    if (r.metodos.mixto) partes.push(r.metodos.mixto + ' mixto');
    if (r.metodos['pago-movil']) partes.push(r.metodos['pago-movil'] + ' Pago Móvil');
    if (r.metodos.punto) partes.push(r.metodos.punto + ' punto');
    return partes.join(' · ');
  }

  /** "Pago Móvil Bs X · Punto Bs Y" (vacío si todo fue Pago Móvil, como en los cierres anteriores a Punto). */
  function textoCanales(r) {
    if (!r.puntoBs) return '';
    return 'Pago Móvil ' + bs(r.pagoMovilBs) + ' · Punto ' + bs(r.puntoBs);
  }

  /** `cerradoEn` (ISO) indica un cierre guardado que se reenvía desde el historial. */
  function mensajeCierre(r, cerradoEn) {
    var lineaVentas = ['Ventas realizadas: ' + r.cantidad + (r.cantidad ? ' (' + textoMetodos(r) + ')' : '')];
    if (r.anuladas) lineaVentas.push('Ventas anuladas: ' + r.anuladas + ' (no suman)');
    var t = encabezadoComercio('Cierre de Caja').concat([
      'Período: ' + textoPeriodo(r),
      cerradoEn ? 'Cerrado: ' + fmtFechaRecibo.format(new Date(cerradoEn)) : 'Generado: ' + fmtFechaRecibo.format(new Date()),
      ''
    ], lineaVentas, [
      '',
      '*Efectivo en caja:* ' + usd(r.efectivoUsd),
      '  Recibido ' + usd(r.recibidoUsd) + ' · Vuelto ' + usd(r.vueltoUsd),
      '*Banco / Pago Móvil:* ' + bs(r.bancoBs)
    ], textoCanales(r) ? ['  ' + textoCanales(r)] : [], [
      '  Equivale a ' + usd(r.bancoUsd)
    ], r.porVerificar ? ['  Sin verificar: ' + r.porVerificar + ' (' + bs(r.porVerificarBs) + ')'] : [], [
      '',
      '*Total general:* ' + usd(r.totalUsd),
      '  Equivale a ' + bs(r.totalBs)
    ]);
    return t.join('\n');
  }

  function pintarCierre(r) {
    poner(el.cierrePeriodo, textoPeriodo(r));
    el.cierreAvisoDias.textContent = r.diasAnteriores
      ? (r.diasAnteriores === 1
        ? 'Hay 1 venta no cerrada de días anteriores. Se incluye en este cierre.'
        : 'Hay ' + r.diasAnteriores + ' ventas no cerradas de días anteriores. Se incluyen en este cierre.')
      : '';
    el.cierreAvisoDias.hidden = !r.diasAnteriores;
    poner(el.cierreCantidad, String(r.cantidad));
    poner(el.cierreCantidadDetalle, textoMetodos(r));
    poner(el.cierreAnuladas, r.anuladas ? plural(r.anuladas, 'venta anulada', 'ventas anuladas') + ' (no suman)' : '');
    el.cierreAnuladas.hidden = !r.anuladas;
    poner(el.cierreEfectivo, usd(r.efectivoUsd));
    poner(el.cierreEfectivoDetalle, 'Recibido ' + usd(r.recibidoUsd) + ' · Vuelto ' + usd(r.vueltoUsd));
    poner(el.cierreBanco, bs(r.bancoBs));
    poner(el.cierreBancoDetalle, (textoCanales(r) ? textoCanales(r) + ' · ' : '') + 'Equivale a ' + usd(r.bancoUsd));
    el.cierreAvisoVerificar.textContent = r.porVerificar
      ? (r.porVerificar === 1 ? 'Hay 1 Pago Móvil sin verificar' : 'Hay ' + r.porVerificar + ' Pagos Móviles sin verificar') +
        ' (' + bs(r.porVerificarBs) + '). Revísalos en tu banco antes de cerrar.'
      : '';
    el.cierreAvisoVerificar.hidden = !r.porVerificar;
    poner(el.cierreTotal, usd(r.totalUsd));
    poner(el.cierreTotalDetalle, 'Equivale a ' + bs(r.totalBs) + ' a la tasa de cada venta');

    var vacio = r.cantidad === 0 && r.anuladas === 0;
    el.cierreWhatsapp.href = vacio ? '#' : 'https://wa.me/?text=' + encodeURIComponent(mensajeCierre(r));
    el.cierreWhatsapp.setAttribute('aria-disabled', String(vacio));
    el.cierreWhatsapp.tabIndex = vacio ? -1 : 0;
    el.cierreArchivar.disabled = vacio;
  }

  function mensajeEnCierre(texto) {
    el.cierreMensaje.textContent = texto || '';
    el.cierreMensaje.hidden = !texto;
  }

  function mostrarConfirmacion(si) {
    el.cierreConfirmacion.hidden = !si;
    el.cierreAcciones.hidden = si;
    if (si) el.cierreCancelar.focus();
  }

  function abrirCierre() {
    if (!el.cierre || !DB) return;
    mostrarConfirmacion(false);
    mensajeEnCierre('');
    DB.ventasAbiertas().then(function (ventas) {
      cierreActual = { ventas: ventas, resumen: resumirCierre(ventas) };
      pintarCierre(cierreActual.resumen);
      if (!ventas.length) mensajeEnCierre('No hay ventas por cerrar. La caja está en cero.');
      if (!el.cierre.open) el.cierre.showModal();
    }).catch(function (e) {
      console.error(e);
      avisar('No se pudo leer las ventas para el cierre.');
    });
  }

  function cerrarModalCierre() {
    mostrarConfirmacion(false);
    if (el.cierre && el.cierre.open) el.cierre.close();
  }

  var archivando = false;

  function limpiarCaja() {
    if (!cierreActual || !cierreActual.ventas.length || archivando) return;
    archivando = true;
    el.cierreConfirmar.disabled = true;
    var r = cierreActual.resumen;
    // Se guarda en decimales, como las ventas.
    var resumen = {
      desde: r.desde, hasta: r.hasta, cantidad: r.cantidad, anuladas: r.anuladas, metodos: r.metodos,
      recibidoUsd: r.recibidoUsd / 100, vueltoUsd: r.vueltoUsd / 100, efectivoUsd: r.efectivoUsd / 100,
      bancoBs: r.bancoBs / 100, bancoUsd: r.bancoUsd / 100,
      pagoMovilBs: r.pagoMovilBs / 100, puntoBs: r.puntoBs / 100, porVerificar: r.porVerificar, porVerificarBs: r.porVerificarBs / 100,
      totalUsd: r.totalUsd / 100, totalBs: r.totalBs / 100
    };
    var ids = cierreActual.ventas.map(function (v) { return v.id; });
    DB.archivarVentas(ids, resumen).then(function () {
      cierreActual = { ventas: [], resumen: resumirCierre([]) };
      mostrarConfirmacion(false);
      pintarCierre(cierreActual.resumen);
      mensajeEnCierre('Caja en cero: se archivaron ' + plural(r.cantidad, 'venta', 'ventas') +
        (r.anuladas ? ' y ' + plural(r.anuladas, 'anulada', 'anuladas') : '') + '.');
      ocultarRecibo();
      limpiarFormulario();
      return renderVentas();
    }).catch(function (e) {
      console.error(e);
      mostrarConfirmacion(false);
      mensajeEnCierre('No se pudo archivar. Intenta de nuevo.');
    }).then(function () {
      archivando = false;
      el.cierreConfirmar.disabled = false;
    });
  }

  // ---------- Historial de cierres ----------
  var cierresGuardados = [];

  /** Cierre guardado (decimales) → el mismo formato en centavos que usa resumirCierre. */
  function cierreACentavos(c) {
    var r = {
      cantidad: Number(c.cantidad) || 0, anuladas: Number(c.anuladas) || 0, diasAnteriores: 0,
      metodos: Object.assign({ efectivo: 0, mixto: 0, 'pago-movil': 0, punto: 0 }, c.metodos || {}),
      desde: c.desde || null, hasta: c.hasta || null, porVerificar: Number(c.porVerificar) || 0
    };
    ['recibidoUsd', 'vueltoUsd', 'efectivoUsd', 'bancoBs', 'bancoUsd', 'puntoBs', 'porVerificarBs', 'totalUsd', 'totalBs'].forEach(function (k) {
      r[k] = cent(c[k]);
    });
    // Cierres anteriores a Punto de venta: todo el banco fue Pago Móvil.
    r.pagoMovilBs = c.pagoMovilBs != null ? cent(c.pagoMovilBs) : r.bancoBs;
    return r;
  }

  function mostrarVistaHistorial(detalle) {
    el.historialVistaLista.hidden = detalle;
    el.historialVistaDetalle.hidden = !detalle;
  }

  function pintarHistorial() {
    el.historialLista.innerHTML = '';
    poner(el.historialNota, cierresGuardados.length
      ? plural(cierresGuardados.length, 'cierre guardado', 'cierres guardados') + ', del más reciente al más antiguo.'
      : 'Aún no hay cierres guardados.');
    if (!cierresGuardados.length) {
      var vacio = document.createElement('li');
      vacio.className = 'historial-vacio';
      vacio.textContent = 'Cuando limpies la caja, el cierre aparecerá aquí.';
      el.historialLista.appendChild(vacio);
      return;
    }
    cierresGuardados.forEach(function (c) {
      var r = cierreACentavos(c);
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'historial-item';
      b.setAttribute('data-cierre', String(c.id));
      b.innerHTML = '<strong></strong><span class="historial-total"></span><span class="historial-sub"></span>';
      b.children[0].textContent = fmtFechaRecibo.format(new Date(c.fecha));
      b.children[1].textContent = usd(r.totalUsd);
      b.children[2].textContent = 'Período ' + textoPeriodo(r) + ' · ' + plural(r.cantidad, 'venta', 'ventas') +
        (r.anuladas ? ' · ' + plural(r.anuladas, 'anulada', 'anuladas') : '');
      li.appendChild(b);
      el.historialLista.appendChild(li);
    });
  }

  function abrirHistorial() {
    if (!el.historial) return;
    DB.cierres().then(function (lista) {
      cierresGuardados = lista;
      pintarHistorial();
      mostrarVistaHistorial(false);
      cerrarModalCierre();
      if (!el.historial.open) el.historial.showModal();
      el.historialCerrar.focus();
    }).catch(function (e) {
      console.error(e);
      mensajeEnCierre('No se pudieron leer los cierres anteriores.');
    });
  }

  function verCierre(id) {
    var c = cierresGuardados.filter(function (x) { return x.id === Number(id); })[0];
    if (!c) return;
    var r = cierreACentavos(c);
    var lineas = [
      ['Cerrado', fmtFechaRecibo.format(new Date(c.fecha))],
      ['Período', textoPeriodo(r)],
      ['Ventas', String(r.cantidad) + (r.cantidad ? ' (' + textoMetodos(r) + ')' : '')]
    ];
    if (r.anuladas) lineas.push(['Anuladas', r.anuladas + ' (no suman)']);
    lineas.push(
      ['Efectivo en caja', usd(r.efectivoUsd)],
      ['Recibido / Vuelto', usd(r.recibidoUsd) + ' / ' + usd(r.vueltoUsd)],
      ['Banco · Pago Móvil', bs(r.bancoBs)]
    );
    if (r.puntoBs) lineas.push(['Pago Móvil / Punto', bs(r.pagoMovilBs) + ' / ' + bs(r.puntoBs)]);
    if (r.porVerificar) lineas.push(['Sin verificar', r.porVerificar + ' (' + bs(r.porVerificarBs) + ')']);
    lineas.push(
      ['Total general', usd(r.totalUsd)],
      ['Total en Bs', bs(r.totalBs)]
    );
    el.historialDetalle.innerHTML = '';
    lineas.forEach(function (l) {
      var dt = document.createElement('dt');
      var dd = document.createElement('dd');
      dt.textContent = l[0];
      dd.textContent = l[1];
      el.historialDetalle.appendChild(dt);
      el.historialDetalle.appendChild(dd);
    });
    el.historialWhatsapp.href = 'https://wa.me/?text=' + encodeURIComponent(mensajeCierre(r, c.fecha));
    mostrarVistaHistorial(true);
    el.historialVolver.focus();
  }

  // ---------- Respaldo ----------
  var RESPALDO_MAX_BYTES = 50 * 1024 * 1024;
  var respaldoPendiente = null; // datos ya validados, esperando confirmación

  function mensajeRespaldo(texto, error) {
    el.respaldoMensaje.textContent = texto || '';
    el.respaldoMensaje.hidden = !texto;
    el.respaldoMensaje.setAttribute('data-tipo', error ? 'error' : 'ok');
    if (texto && el.respaldoMensaje.scrollIntoView) el.respaldoMensaje.scrollIntoView({ block: 'nearest' });
  }

  function mostrarConfirmacionRespaldo(texto) {
    el.respaldoConfirmacionTexto.textContent = texto || '';
    el.respaldoConfirmacion.hidden = !texto;
    if (texto) {
      el.respaldoCancelar.focus();
      if (el.respaldoConfirmacion.scrollIntoView) el.respaldoConfirmacion.scrollIntoView({ block: 'nearest' });
    }
  }

  function nombreRespaldo(fecha) {
    var hhmm = String(fecha.getHours()).padStart(2, '0') + String(fecha.getMinutes()).padStart(2, '0');
    return 'cuadre-respaldo-' + DB.diaLocal(fecha) + '-' + hhmm + '.json';
  }

  function descargar(archivo) {
    var url = URL.createObjectURL(archivo);
    var a = document.createElement('a');
    a.href = url;
    a.download = archivo.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /** Comparte el archivo con el menú nativo (WhatsApp, Drive…) si se puede; si no, lo descarga. */
  function exportarRespaldo() {
    mostrarConfirmacionRespaldo('');
    mensajeRespaldo('');
    el.respaldoExportar.disabled = true;
    var resumen;
    DB.exportarRespaldo().then(function (datos) {
      resumen = plural(datos.ventas.length, 'venta', 'ventas') + ' y ' + plural(datos.cierres.length, 'cierre', 'cierres');
      var archivo = new File([JSON.stringify(datos)], nombreRespaldo(new Date()), { type: 'application/json' });
      var compartible = navigator.canShare && navigator.share && navigator.canShare({ files: [archivo] });
      if (!compartible) { descargar(archivo); return 'descargado'; }
      return navigator.share({ files: [archivo], title: 'Respaldo de Cuadre' }).then(function () {
        return 'compartido';
      }, function (e) {
        if (e && e.name === 'AbortError') return 'cancelado';
        descargar(archivo); // el menú falló: queda la descarga
        return 'descargado';
      });
    }).then(function (como) {
      if (como === 'cancelado') return;
      mensajeRespaldo(como === 'compartido'
        ? 'Respaldo compartido: ' + resumen + '.'
        : 'Respaldo descargado: ' + resumen + '. Guárdalo fuera del teléfono (WhatsApp, correo o Drive).');
    }).catch(function (e) {
      console.error(e);
      mensajeRespaldo('No se pudo crear el respaldo. Intenta de nuevo.', true);
    }).then(function () {
      el.respaldoExportar.disabled = false;
    });
  }

  function leerTexto(archivo) {
    if (archivo.text) return archivo.text();
    return new Promise(function (resolve, reject) {
      var lector = new FileReader();
      lector.onload = function () { resolve(lector.result); };
      lector.onerror = function () { reject(lector.error); };
      lector.readAsText(archivo);
    });
  }

  /** Lee y valida el archivo. No toca nada: solo pide confirmación si el respaldo es válido. */
  function elegirRespaldo() {
    var archivo = el.respaldoImportar.files && el.respaldoImportar.files[0];
    el.respaldoImportar.value = '';
    if (!archivo) return;
    respaldoPendiente = null;
    mostrarConfirmacionRespaldo('');
    mensajeRespaldo('');
    if (archivo.size > RESPALDO_MAX_BYTES) return mensajeRespaldo('El archivo es demasiado grande para ser un respaldo de Cuadre.', true);
    leerTexto(archivo).then(function (texto) {
      var datos;
      try { datos = JSON.parse(texto); } catch (e) { throw new Error('El archivo no es un respaldo válido: no se pudo leer como JSON.'); }
      var nuevo = DB.validarRespaldo(datos);
      return DB.exportarRespaldo().then(function (actual) {
        respaldoPendiente = datos;
        var hechoEl = nuevo.exportado ? ' del ' + fmtFechaRecibo.format(new Date(nuevo.exportado)) : '';
        mostrarConfirmacionRespaldo(
          'El respaldo' + hechoEl + ' trae ' + plural(nuevo.ventas, 'venta', 'ventas') + ' y ' +
          plural(nuevo.cierres, 'cierre', 'cierres') + '. Reemplazará TODO lo que hay en este teléfono (' +
          plural(actual.ventas.length, 'venta', 'ventas') + ' y ' + plural(actual.cierres.length, 'cierre', 'cierres') +
          ', tasas y ajustes). ¿Continuar?');
      });
    }).catch(function (e) {
      console.warn(e); // archivo rechazado: se explica en pantalla
      mensajeRespaldo(e && e.message ? e.message : 'No se pudo leer el archivo.', true);
    });
  }

  var importando = false;

  function confirmarImportacion() {
    if (!respaldoPendiente || importando) return;
    importando = true;
    el.respaldoConfirmar.disabled = true;
    DB.importarRespaldo(respaldoPendiente).then(function (r) {
      respaldoPendiente = null;
      mostrarConfirmacionRespaldo('');
      ocultarRecibo();
      limpiarFormulario();
      return cargarDatos().then(function () {
        abrirAjustes(); // refresca nombre, logo y tema del formulario con lo importado
        mensajeRespaldo('Respaldo importado: ' + plural(r.ventas, 'venta', 'ventas') + ' y ' + plural(r.cierres, 'cierre', 'cierres') + '.');
      });
    }).catch(function (e) {
      console.error(e);
      mostrarConfirmacionRespaldo('');
      mensajeRespaldo(e && e.message ? e.message : 'No se pudo importar. Tus datos no cambiaron.', true);
    }).then(function () {
      importando = false;
      el.respaldoConfirmar.disabled = false;
    });
  }

  function cancelarImportacion() {
    respaldoPendiente = null;
    mostrarConfirmacionRespaldo('');
    mensajeRespaldo('Importación cancelada. Tus datos no cambiaron.');
  }

  // ---------- Vistas (menú inferior) ----------
  var vistaActual = 'caja';

  function irA(vista) {
    var secciones = {
      caja: el.vistaCaja, resumen: el.vistaResumen, inventario: el.vistaInventario, ajustes: el.vistaAjustes,
      registro: el.vistaRegistro, portada: el.vistaPortada, ingresar: el.vistaIngresar
    };
    var afuera = vista === 'registro' || vista === 'portada' || vista === 'ingresar';
    if (!secciones[vista]) return;
    vistaActual = vista;
    Object.keys(secciones).forEach(function (k) { if (secciones[k]) secciones[k].hidden = k !== vista; });
    el.menu.hidden = afuera;
    el.acceso.hidden = !afuera;
    el.estadoConexion.hidden = afuera;
    el.abrirCierre.hidden = vista !== 'caja';
    if (vista === 'ingresar') prepararIngreso();
    Array.prototype.forEach.call(el.menu.querySelectorAll('[data-vista]'), function (b) {
      if (b.getAttribute('data-vista') === vista) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.body.setAttribute('data-vista', vista);
    window.scrollTo(0, 0);
    if (vista === 'resumen') pintarDashboard();
    if (vista === 'ajustes') abrirAjustes();
    if (vista === 'inventario') cargarCatalogo().then(function () { pintarInventario(); nuevoProducto(); });
    if (vista === 'caja') refrescarCatalogo();
  }

  // ---------- Cuenta local: PIN y sesión ----------
  var CLAVE_SESION = 'cuadre-sesion';
  var intentosPin = 0, bloqueoPinHasta = 0;

  function hayCuenta() { return !!(estado.comercio.registrado || estado.comercio.nombre); }

  function sesionActiva() {
    try { return localStorage.getItem(CLAVE_SESION) === '1'; } catch (e) { return true; }
  }
  function abrirSesion() { try { localStorage.setItem(CLAVE_SESION, '1'); } catch (e) { /* sin almacenamiento */ } }
  function cerrarSesion() {
    try { localStorage.removeItem(CLAVE_SESION); } catch (e) { /* sin almacenamiento */ }
    ocultarRecibo();
    limpiarFormulario();
    irA('portada');
  }

  function pinValido(pin) { return /^\d{4,6}$/.test(pin); }

  function nuevaSal() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /** SHA-256 de "sal:PIN" en hexadecimal. Solo funciona en HTTPS (o localhost). */
  function hashPin(pin, sal) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('Este navegador no permite guardar el PIN de forma segura.'));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(sal + ':' + pin)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function datosPin(pin) {
    var sal = nuevaSal();
    return hashPin(pin, sal).then(function (h) { return { pinHash: h, pinSal: sal }; });
  }

  /** A dónde va la app al abrir: portada si no hay cuenta o se cerró la sesión; si no, la caja. */
  function vistaInicial() {
    if (!hayCuenta()) return 'portada';
    if (!estado.comercio.pinHash) return 'caja'; // cuentas de antes del PIN entran directo
    return sesionActiva() ? 'caja' : 'portada';
  }

  function mensajeIngreso(texto) {
    el.ingresarMensaje.textContent = texto || '';
    el.ingresarMensaje.hidden = !texto;
  }

  function prepararIngreso() {
    var c = estado.comercio;
    var cuenta = hayCuenta();
    mensajeIngreso('');
    el.ingresarPin.value = '';
    el.ingresarCuenta.hidden = !cuenta;
    el.ingresarSinCuenta.hidden = cuenta;
    el.ingresarPinCampo.hidden = !(cuenta && c.pinHash);
    el.ingresarEntrar.hidden = !cuenta;
    poner(el.ingresarNombre, c.nombre || 'Tu negocio');
    if (c.logo) { el.ingresarLogo.src = c.logo; el.ingresarLogo.hidden = false; } else { el.ingresarLogo.hidden = true; }
    poner(el.ingresarNota, !cuenta ? 'No hay ninguna cuenta en este teléfono.'
      : c.pinHash ? 'Escribe tu PIN para entrar.' : 'Esta cuenta no tiene PIN. Puedes ponerle uno en Ajustes.');
    if (cuenta && c.pinHash) setTimeout(function () { el.ingresarPin.focus(); }, 50);
  }

  function ingresar(e) {
    if (e) e.preventDefault();
    var c = estado.comercio;
    if (!hayCuenta()) return;
    if (!c.pinHash) { abrirSesion(); irA('caja'); return; }
    var espera = Math.ceil((bloqueoPinHasta - Date.now()) / 1000);
    if (espera > 0) { mensajeIngreso('Demasiados intentos. Espera ' + espera + ' segundos.'); return; }
    var pin = el.ingresarPin.value.trim();
    if (!pinValido(pin)) { mensajeIngreso('El PIN tiene de 4 a 6 números.'); el.ingresarPin.focus(); return; }
    hashPin(pin, c.pinSal).then(function (h) {
      if (h !== c.pinHash) {
        intentosPin++;
        if (intentosPin >= 5) { intentosPin = 0; bloqueoPinHasta = Date.now() + 30000; }
        el.ingresarPin.value = '';
        mensajeIngreso('PIN incorrecto.');
        el.ingresarPin.focus();
        return;
      }
      intentosPin = 0;
      abrirSesion();
      irA('caja');
    }).catch(function (err) {
      mensajeIngreso(err.message);
    });
  }

  /** "Crear cuenta": con una cuenta ya guardada en el teléfono, se ofrece entrar a ella. */
  function irACrear() {
    if (hayCuenta()) {
      irA('ingresar');
      mensajeIngreso('Ya hay una cuenta en este teléfono: entra con tu PIN.');
      return;
    }
    irA('registro');
    llenarTasaRegistro();
  }

  // ---------- Registro inicial ----------
  var registroLogo = null, registroColores = null;

  function mensajeRegistro(texto) {
    el.registroMensaje.textContent = texto || '';
    el.registroMensaje.hidden = !texto;
  }

  function elegirLogoRegistro() {
    var archivo = el.registroLogo.files && el.registroLogo.files[0];
    if (!archivo) return;
    mensajeRegistro('');
    procesarLogo(archivo).then(function (dataUrl) {
      registroLogo = dataUrl;
      el.registroLogoVista.src = dataUrl;
      el.registroLogoVista.hidden = false;
      el.registroLogoVacio.hidden = true;
      return coloresDeLogo(dataUrl);
    }).then(function (colores) {
      if (registroLogo === null) return;
      registroColores = colores;
      pintarPaleta(el.registroPaleta, colores, !colores);
      aplicarTema(colores ? 'logo' : 'esmeralda', colores);
    }).catch(function (e) {
      mensajeRegistro(e.message);
    }).then(function () {
      el.registroLogo.value = '';
    });
  }

  function crearCuenta(e) {
    if (e) e.preventDefault();
    var nombre = el.registroNombre.value.trim();
    var tasa = parsearTasa(el.registroTasa.value);
    if (!nombre) { mensajeRegistro('Escribe el nombre de tu negocio.'); el.registroNombre.focus(); return; }
    if (!isFinite(tasa) || tasa <= 0) { mensajeRegistro('Escribe la tasa BCV de hoy, por ejemplo 36,50.'); el.registroTasa.focus(); return; }
    var pin = el.registroPin.value.trim();
    if (!pinValido(pin)) { mensajeRegistro('Elige un PIN de 4 a 6 números para entrar.'); el.registroPin.focus(); return; }
    var cambios = {
      nombre: nombre, contacto: el.registroContacto.value, registrado: true,
      pmBanco: el.registroPmBanco.value, pmTelefono: el.registroPmTelefono.value, pmDocumento: el.registroPmDocumento.value,
      tema: registroColores ? 'logo' : temaActual() === 'logo' ? 'esmeralda' : temaActual()
    };
    if (registroLogo) cambios.logo = registroLogo;
    if (registroColores) cambios.colores = registroColores;
    el.registroCrear.disabled = true;
    datosPin(pin).then(function (p) {
      Object.assign(cambios, p);
      // Si es la misma que llegó sola, se conserva su fuente.
      if (estado.tasa && Math.abs(estado.tasa.valor - tasa) < 1e-9) return estado.tasa;
      return DB.guardarTasa(tasa, 'bcv');
    }).then(function (t) {
      estado.tasa = t;
      return DB.guardarAjustes(cambios);
    }).then(function (a) {
      estado.comercio = a;
      abrirSesion();
      aplicarTema(a.tema || 'esmeralda', a.colores);
      pintarMarca();
      mostrarTasa();
      recalcular();
      irA('caja');
    }).catch(function (err) {
      console.error(err);
      mensajeRegistro('No se pudo crear la cuenta. Intenta de nuevo.');
    }).then(function () {
      el.registroCrear.disabled = false;
    });
  }

  // ---------- Inventario y productos de la venta ----------
  var fmtCant = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 });
  function fmtCantidad(n) { return fmtCant.format(n); }

  function hayCarrito() { return Object.keys(estado.carrito).length > 0; }

  function productoPorId(id) {
    return estado.catalogo.filter(function (p) { return p.id === Number(id); })[0] || null;
  }

  function itemsCarrito() {
    return Object.keys(estado.carrito).map(function (id) {
      var p = productoPorId(id);
      return p ? { productoId: p.id, nombre: p.nombre, precioUsd: p.precioUsd, cantidad: estado.carrito[id] } : null;
    }).filter(Boolean);
  }

  function totalItemsCent(items) {
    return items.reduce(function (t, it) { return t + Math.round(cent(it.precioUsd) * it.cantidad); }, 0);
  }

  function contarUnidades(items) {
    return items.reduce(function (t, it) { return t + it.cantidad; }, 0);
  }

  /** "Harina PAN ×2, Queso" (máx. 3 nombres). */
  function resumenItems(items) {
    var nombres = items.slice(0, 3).map(function (it) { return it.nombre + (it.cantidad !== 1 ? ' ×' + fmtCantidad(it.cantidad) : ''); });
    return nombres.join(', ') + (items.length > 3 ? ' y ' + (items.length - 3) + ' más' : '');
  }

  function textoCarrito(items) {
    if (!items.length) return 'Sin productos';
    var u = contarUnidades(items);
    return fmtCantidad(u) + (u === 1 ? ' producto · ' : ' productos · ') + usd(totalItemsCent(items));
  }

  /** Con productos, el total de la factura es su suma. */
  function pintarCarrito() {
    if (!el.carrito) return;
    var items = itemsCarrito();
    el.carrito.hidden = !items.length;
    poner(el.carritoResumen, items.length ? textoCarrito(items) + ' · ' + resumenItems(items) : '');
    if (items.length) {
      var c = totalItemsCent(items);
      estado.entrada.total = (c % 100 === 0) ? String(c / 100) : (c / 100).toFixed(2);
    }
    if (el.totalUsd) el.totalUsd.closest('.campo-caja').toggleAttribute('data-bloqueado', items.length > 0);
    pintarRejilla();
  }

  function cargarCatalogo() {
    return DB.obtenerCatalogo().then(function (lista) {
      estado.catalogo = lista;
      // Productos borrados mientras estaban en la venta en curso: se sacan.
      Object.keys(estado.carrito).forEach(function (id) { if (!productoPorId(id)) delete estado.carrito[id]; });
    });
  }

  function textoStock(p) {
    if (p.stock == null) return '';
    if (p.stock <= 0) return 'Agotado';
    return 'Quedan ' + fmtCantidad(p.stock);
  }

  function irAInventario() {
    cerrarProductos();
    irA('inventario');
    el.invNombre.focus();
  }

  function abrirProductos() {
    if (!el.productos) return;
    empezarEdicion();
    return cargarCatalogo().then(function () {
      el.productosBuscar.value = '';
      pintarElegir();
      if (!el.productos.open) el.productos.showModal();
      el.productosCerrar.focus();
    }).catch(function (e) {
      console.error(e);
      avisar('No se pudo abrir el inventario.');
    });
  }

  function pintarElegir() {
    var q = el.productosBuscar.value.trim().toLowerCase();
    var lista = estado.catalogo.filter(function (p) { return !q || p.nombre.toLowerCase().indexOf(q) !== -1; });
    el.productosLista.innerHTML = '';
    el.productosVacio.hidden = estado.catalogo.length > 0;
    el.productosBuscar.closest('label').hidden = estado.catalogo.length < 6;
    lista.forEach(function (p) {
      var cant = estado.carrito[p.id] || 0;
      var li = document.createElement('li');
      li.className = 'producto' + (cant ? ' producto-elegido' : '');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'producto-boton';
      b.setAttribute('data-agregar', String(p.id));
      b.innerHTML = '<span class="producto-nombre"></span><span class="producto-precio"></span><span class="producto-stock"></span>';
      b.children[0].textContent = p.nombre;
      b.children[1].textContent = usd(cent(p.precioUsd));
      b.children[2].textContent = textoStock(p);
      if (p.stock != null && p.stock - cant <= 0) b.children[2].setAttribute('data-agotado', '');
      b.setAttribute('aria-label', 'Sumar ' + p.nombre + ', ' + usd(cent(p.precioUsd)) + (cant ? '. Llevas ' + fmtCantidad(cant) : ''));
      li.appendChild(b);
      if (cant) {
        var menos = document.createElement('button');
        menos.type = 'button';
        menos.className = 'boton producto-menos';
        menos.setAttribute('data-restar', String(p.id));
        menos.setAttribute('aria-label', 'Quitar uno de ' + p.nombre);
        menos.textContent = '−';
        var n = document.createElement('span');
        n.className = 'producto-cantidad';
        n.textContent = fmtCantidad(cant);
        li.appendChild(menos);
        li.appendChild(n);
      }
      el.productosLista.appendChild(li);
    });
    if (estado.catalogo.length && !lista.length) {
      var vacio = document.createElement('li');
      vacio.className = 'venta-vacia';
      vacio.textContent = 'Ningún producto coincide.';
      el.productosLista.appendChild(vacio);
    }
    poner(el.productosTotal, textoCarrito(itemsCarrito()));
  }

  function cambiarCantidad(id, delta) {
    var actual = estado.carrito[id] || 0;
    var nueva = actual + delta;
    if (nueva <= 0) delete estado.carrito[id]; else estado.carrito[id] = nueva;
    pintarElegir();
  }

  function cerrarProductos() {
    if (el.productos.open) el.productos.close();
  }

  /** Al cerrar el selector, el total pasa a la calculadora. */
  function alCerrarProductos() {
    var habia = hayCarrito();
    pintarCarrito();
    if (habia) activarCampo('recibido');
    recalcular();
  }

  function quitarCarrito() {
    estado.carrito = {};
    estado.entrada.total = '';
    pintarCarrito();
    activarCampo('total');
    recalcular();
  }

  // ---------- Productos en la Caja (un toque suma) ----------
  /** Iniciales para el cuadro de un producto sin foto: "Harina PAN" → "HP". */
  function iniciales(nombre) {
    var p = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '?').charAt(0) + (p[1] ? p[1].charAt(0) : '')).toUpperCase();
  }

  function pintarRejilla() {
    if (!el.rejilla) return;
    var hay = estado.catalogo.length > 0;
    el.rejilla.hidden = !hay;
    el.abrirProductos.hidden = hay;
    if (!hay) return;
    var buscar = el.rejillaBuscar.closest('label');
    buscar.hidden = estado.catalogo.length < 9;
    var q = buscar.hidden ? '' : el.rejillaBuscar.value.trim().toLowerCase();
    var lista = estado.catalogo.filter(function (p) { return !q || p.nombre.toLowerCase().indexOf(q) !== -1; });
    el.rejillaLista.innerHTML = '';
    lista.forEach(function (p) {
      var cant = estado.carrito[p.id] || 0;
      var li = document.createElement('li');
      li.className = 'tile' + (cant ? ' tile-elegido' : '');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile-boton';
      b.setAttribute('data-sumar', String(p.id));
      var foto;
      if (p.foto) {
        foto = document.createElement('img');
        foto.className = 'tile-foto';
        foto.src = p.foto;
        foto.alt = '';
      } else {
        foto = document.createElement('span');
        foto.className = 'tile-foto tile-inicial';
        foto.setAttribute('aria-hidden', 'true');
        foto.textContent = iniciales(p.nombre);
      }
      b.appendChild(foto);
      var nombre = document.createElement('span');
      nombre.className = 'tile-nombre';
      nombre.textContent = p.nombre;
      var precio = document.createElement('span');
      precio.className = 'tile-precio';
      precio.textContent = usd(cent(p.precioUsd));
      b.appendChild(nombre);
      b.appendChild(precio);
      if (p.stock != null) {
        var stock = document.createElement('span');
        stock.className = 'tile-stock';
        var queda = p.stock - cant;
        stock.textContent = queda <= 0 ? 'Agotado' : 'Quedan ' + fmtCantidad(queda);
        if (queda <= 0) stock.setAttribute('data-agotado', '');
        b.appendChild(stock);
      }
      b.setAttribute('aria-label', 'Sumar ' + p.nombre + ', ' + usd(cent(p.precioUsd)) + (cant ? '. Llevas ' + fmtCantidad(cant) : ''));
      li.appendChild(b);
      if (cant) {
        var n = document.createElement('span');
        n.className = 'tile-cantidad';
        n.textContent = fmtCantidad(cant);
        var menos = document.createElement('button');
        menos.type = 'button';
        menos.className = 'tile-menos';
        menos.setAttribute('data-restar-tile', String(p.id));
        menos.setAttribute('aria-label', 'Quitar uno de ' + p.nombre);
        menos.textContent = '−';
        li.appendChild(n);
        li.appendChild(menos);
      }
      el.rejillaLista.appendChild(li);
    });
    if (!lista.length) {
      var vacio = document.createElement('li');
      vacio.className = 'venta-vacia';
      vacio.textContent = 'Ningún producto coincide.';
      el.rejillaLista.appendChild(vacio);
    }
  }

  function sumarProducto(id, delta) {
    if (!productoPorId(id)) return;
    empezarEdicion();
    var nueva = (estado.carrito[id] || 0) + delta;
    if (nueva <= 0) delete estado.carrito[id]; else estado.carrito[id] = nueva;
    if (!hayCarrito()) estado.entrada.total = '';
    pintarCarrito();
    if (hayCarrito() && estado.campoActivo === 'total') activarCampo('recibido');
    if (!hayCarrito()) activarCampo('total');
    recalcular();
    vibrar();
  }

  function refrescarCatalogo() {
    return cargarCatalogo().then(function () { pintarCarrito(); recalcular(); }).catch(function (e) { console.warn(e); });
  }

  // Editor de inventario
  var productoEditando = null;
  var confirmandoEliminar = false;

  function mensajeInv(texto) {
    el.invMensaje.textContent = texto || '';
    el.invMensaje.hidden = !texto;
  }

  // Foto del producto en edición: undefined = sin cambio, null = quitarla, data URL = nueva.
  var fotoProducto;
  var FOTO_PX = 240;

  /** Recorta la imagen al centro en un cuadrado de 240 px (JPEG liviano). */
  function procesarFoto(archivo) {
    return new Promise(function (resolve, reject) {
      if (!archivo || !/^image\//.test(archivo.type)) return reject(new Error('Elige un archivo de imagen.'));
      if (archivo.size > LOGO_MAX_BYTES) return reject(new Error('La imagen pesa más de 10 MB.'));
      var url = URL.createObjectURL(archivo);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight, lado = Math.min(w, h);
        var c = document.createElement('canvas');
        c.width = c.height = Math.min(FOTO_PX, lado) || FOTO_PX;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, (w - lado) / 2, (h - lado) / 2, lado, lado, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer esa imagen.'));
      };
      img.src = url;
    });
  }

  function pintarFotoInv(src) {
    if (src) { el.invFotoVista.src = src; el.invFotoVista.hidden = false; }
    else { el.invFotoVista.removeAttribute('src'); el.invFotoVista.hidden = true; }
    el.invFotoVacio.hidden = !!src;
    el.invFotoQuitar.hidden = !src;
  }

  function elegirFoto() {
    var archivo = el.invFoto.files && el.invFoto.files[0];
    if (!archivo) return;
    procesarFoto(archivo).then(function (dataUrl) {
      fotoProducto = dataUrl;
      pintarFotoInv(dataUrl);
      mensajeInv('');
    }).catch(function (e) {
      mensajeInv(e.message);
    }).then(function () {
      el.invFoto.value = '';
    });
  }

  function quitarFoto() {
    fotoProducto = null;
    pintarFotoInv(null);
  }

  function nuevoProducto() {
    productoEditando = null;
    confirmandoEliminar = false;
    fotoProducto = undefined;
    pintarFotoInv(null);
    el.invNombre.value = '';
    el.invPrecio.value = '';
    el.invStock.value = '';
    el.invEliminar.hidden = true;
    poner(el.invEliminar, 'Eliminar');
    poner(el.invFormTitulo, 'Nuevo producto');
    poner(el.invGuardar, 'Guardar producto');
    mensajeInv('');
  }

  function editarProducto(id) {
    var p = productoPorId(id);
    if (!p) return;
    productoEditando = p.id;
    confirmandoEliminar = false;
    fotoProducto = undefined;
    pintarFotoInv(p.foto || null);
    el.invNombre.value = p.nombre;
    el.invPrecio.value = fmtMonto.format(p.precioUsd);
    el.invStock.value = p.stock == null ? '' : fmtCantidad(p.stock);
    el.invEliminar.hidden = false;
    poner(el.invEliminar, 'Eliminar');
    poner(el.invFormTitulo, 'Editar producto');
    poner(el.invGuardar, 'Guardar cambios');
    mensajeInv('');
    el.invNombre.focus();
  }

  function pintarInventario() {
    el.invLista.innerHTML = '';
    if (!estado.catalogo.length) {
      var vacio = document.createElement('li');
      vacio.className = 'venta-vacia';
      vacio.textContent = 'Todavía no hay productos.';
      el.invLista.appendChild(vacio);
      return;
    }
    estado.catalogo.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'producto';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'producto-boton';
      b.setAttribute('data-editar-producto', String(p.id));
      b.innerHTML = '<span class="producto-nombre"></span><span class="producto-precio"></span><span class="producto-stock"></span>';
      b.children[0].textContent = p.nombre;
      if (p.foto) {
        var mini = document.createElement('img');
        mini.className = 'producto-mini';
        mini.src = p.foto;
        mini.alt = '';
        b.classList.add('con-foto');
        b.insertBefore(mini, b.firstChild);
      }
      b.children[1].textContent = usd(cent(p.precioUsd));
      b.children[2].textContent = p.stock == null ? 'Sin control de stock' : textoStock(p);
      if (p.stock != null && p.stock <= 0) b.children[2].setAttribute('data-agotado', '');
      b.setAttribute('aria-label', 'Editar ' + p.nombre);
      li.appendChild(b);
      el.invLista.appendChild(li);
    });
  }

  function guardarProducto(e) {
    if (e) e.preventDefault();
    var precio = parsearTasa(el.invPrecio.value);
    var stockTexto = el.invStock.value.trim();
    var stock = stockTexto ? parsearTasa(stockTexto) : null;
    if (!el.invNombre.value.trim()) { mensajeInv('Escribe el nombre del producto.'); el.invNombre.focus(); return; }
    if (!isFinite(precio) || precio <= 0) { mensajeInv('Escribe un precio como 1,20.'); el.invPrecio.focus(); return; }
    if (stockTexto && !isFinite(stock)) { mensajeInv('El stock debe ser un número, o déjalo vacío.'); el.invStock.focus(); return; }
    el.invGuardar.disabled = true;
    DB.guardarProducto({ id: productoEditando, nombre: el.invNombre.value, precioUsd: precio, stock: stock, foto: fotoProducto }).then(function () {
      return cargarCatalogo();
    }).then(function () {
      pintarInventario();
      pintarElegir();
      pintarCarrito();
      nuevoProducto();
      mensajeInv('');
      el.invNombre.focus();
    }).catch(function (err) {
      console.error(err);
      mensajeInv(err && err.message ? err.message : 'No se pudo guardar. Intenta de nuevo.');
    }).then(function () {
      el.invGuardar.disabled = false;
    });
  }

  /** Dos toques: el primero pide confirmar, el segundo elimina. */
  function eliminarProducto() {
    if (productoEditando == null) return;
    if (!confirmandoEliminar) {
      confirmandoEliminar = true;
      poner(el.invEliminar, '¿Seguro? Toca otra vez');
      return;
    }
    DB.eliminarProducto(productoEditando).then(cargarCatalogo).then(function () {
      pintarInventario();
      pintarElegir();
      pintarCarrito();
      recalcular();
      nuevoProducto();
    }).catch(function (err) {
      console.error(err);
      mensajeInv('No se pudo eliminar. Intenta de nuevo.');
    });
  }

  // ---------- Dashboard ----------
  var fmtDiaSemana = new Intl.DateTimeFormat('es-VE', { weekday: 'short' });
  var fmtDiaMes = new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: '2-digit' });
  var fmtDiaLargo = new Intl.DateTimeFormat('es-VE', { weekday: 'long', day: 'numeric', month: 'short' });
  var dashBarras = []; // [{ etiqueta, usd, ventas }] del gráfico en pantalla

  function sumarDias(fecha, n) {
    var d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  function pintarDashboard() {
    var periodo = estado.dashPeriodo;
    var hoy = new Date();
    var dias = periodo === 'hoy' ? 1 : Number(periodo);
    var inicio = sumarDias(hoy, -(dias - 1));
    Array.prototype.forEach.call(el.dashboardPeriodos.querySelectorAll('[data-periodo]'), function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-periodo') === periodo));
    });
    poner(el.dashboardPeriodo, periodo === 'hoy' ? 'Hoy, ' + diaLegible(DB.diaLocal(hoy)) : diaLegible(DB.diaLocal(inicio)) + ' al ' + diaLegible(DB.diaLocal(hoy)));
    return DB.ventasEntre(DB.diaLocal(inicio), DB.diaLocal(hoy)).then(function (todas) {
      var ventas = todas.filter(function (v) { return !v.anuladaEn; });
      var r = resumirCierre(ventas);
      pintarKpis(r);
      pintarGrafico(ventas, periodo, inicio, dias);
      pintarMetodos(ventas, r);
      pintarTopProductos(ventas);
    }).catch(function (e) {
      console.error(e);
      poner(el.dashLectura, 'No se pudieron leer las ventas.');
    });
  }

  function tile(etiqueta, valor, detalle, tono) {
    var d = document.createElement('div');
    d.className = 'dash-kpi';
    if (tono) d.setAttribute('data-tono', tono);
    d.innerHTML = '<span class="etiqueta"></span><strong class="dash-kpi-valor"></strong><span class="dash-kpi-detalle"></span>';
    d.children[0].textContent = etiqueta;
    d.children[1].textContent = valor;
    d.children[2].textContent = detalle || '';
    return d;
  }

  function pintarKpis(r) {
    el.dashKpis.innerHTML = '';
    var promedio = r.cantidad ? Math.round(r.totalUsd / r.cantidad) : 0;
    el.dashKpis.appendChild(tile('Vendido', usd(r.totalUsd), bs(r.totalBs)));
    el.dashKpis.appendChild(tile('Ventas', String(r.cantidad), r.cantidad ? 'Ticket promedio ' + usd(promedio) : 'Sin ventas'));
    el.dashKpis.appendChild(tile('Efectivo neto', usd(r.efectivoUsd), 'Recibido menos vuelto'));
    el.dashKpis.appendChild(tile('Banco', bs(r.bancoBs), r.puntoBs ? 'Punto ' + bs(r.puntoBs) : 'Pago Móvil'));
    el.dashKpis.appendChild(r.porVerificar
      ? tile('Por verificar', String(r.porVerificar), bs(r.porVerificarBs) + ' en Pago Móvil', 'aviso')
      : tile('Pago Móvil', '✓', 'Todo verificado'));
  }

  /** Barras de una sola serie (USD vendidos): por hora hoy, por día en 7 y 30 días. */
  function pintarGrafico(ventas, periodo, inicio, dias) {
    var barras = [];
    if (periodo === 'hoy') {
      var horas = ventas.map(function (v) { return new Date(v.fecha).getHours(); });
      var desde = Math.min.apply(null, [8].concat(horas));
      var hasta = Math.max.apply(null, [18].concat(horas));
      for (var h = desde; h <= hasta; h++) barras.push({ clave: h, etiqueta: h + 'h', largo: h + ':00 a ' + h + ':59', usd: 0, ventas: 0 });
      ventas.forEach(function (v) {
        var b = barras[new Date(v.fecha).getHours() - desde];
        b.usd += desglose(v).totalUsd; b.ventas++;
      });
      poner(el.dashGraficoTitulo, 'Ventas por hora (USD)');
    } else {
      var indice = {};
      for (var i = 0; i < dias; i++) {
        var f = sumarDias(inicio, i);
        var b = {
          clave: DB.diaLocal(f), usd: 0, ventas: 0, largo: fmtDiaLargo.format(f),
          etiqueta: dias <= 7 ? fmtDiaSemana.format(f).replace('.', '') : fmtDiaMes.format(f)
        };
        indice[b.clave] = b;
        barras.push(b);
      }
      ventas.forEach(function (v) {
        var b = indice[v.dia];
        if (b) { b.usd += desglose(v).totalUsd; b.ventas++; }
      });
      poner(el.dashGraficoTitulo, 'Ventas por día (USD)');
    }
    dashBarras = barras;

    var W = 340, H = 150, abajo = 20, arriba = 18;
    var max = Math.max.apply(null, barras.map(function (b) { return b.usd; }).concat([1]));
    var paso = W / barras.length;
    var ancho = Math.max(2, paso - 2);
    var alto = H - abajo - arriba;
    var cadaEtiqueta = barras.length > 12 ? Math.ceil(barras.length / 6) : (barras.length > 8 ? 2 : 1);
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="dash-svg" role="img" aria-label="' +
      el.dashGraficoTitulo.textContent + '">';
    svg += '<line x1="0" x2="' + W + '" y1="' + arriba + '" y2="' + arriba + '" class="dash-guia"/>';
    svg += '<text x="0" y="' + (arriba - 5) + '" class="dash-eje">' + usd(max === 1 ? 0 : max) + '</text>';
    svg += '<line x1="0" x2="' + W + '" y1="' + (H - abajo) + '" y2="' + (H - abajo) + '" class="dash-base"/>';
    barras.forEach(function (b, i) {
      var x = i * paso + (paso - ancho) / 2;
      var h = b.usd ? Math.max(3, (b.usd / max) * alto) : 0;
      var y = H - abajo - h;
      var rr = Math.min(4, ancho / 2, h);
      svg += '<g class="dash-barra" data-barra="' + i + '">';
      svg += '<rect x="' + (i * paso) + '" y="0" width="' + paso + '" height="' + (H - abajo) + '" class="dash-hit"/>';
      if (h) {
        svg += '<path class="dash-marca" d="M' + x + ',' + (H - abajo) + 'V' + (y + rr) + 'Q' + x + ',' + y + ' ' + (x + rr) + ',' + y +
          'H' + (x + ancho - rr) + 'Q' + (x + ancho) + ',' + y + ' ' + (x + ancho) + ',' + (y + rr) + 'V' + (H - abajo) + 'Z"/>';
      }
      svg += '</g>';
      if (i % cadaEtiqueta === 0) {
        svg += '<text x="' + (i * paso + paso / 2) + '" y="' + (H - 5) + '" text-anchor="middle" class="dash-eje">' + b.etiqueta + '</text>';
      }
    });
    svg += '</svg>';
    el.dashGrafico.innerHTML = svg;
    // Tabla accesible con los mismos datos.
    var tabla = document.createElement('table');
    tabla.className = 'visualmente-oculto';
    tabla.innerHTML = '<caption></caption><thead><tr><th>Período</th><th>Ventas</th><th>USD</th></tr></thead><tbody></tbody>';
    tabla.caption.textContent = el.dashGraficoTitulo.textContent;
    barras.forEach(function (b) {
      var tr = tabla.tBodies[0].insertRow();
      tr.insertCell().textContent = b.largo;
      tr.insertCell().textContent = String(b.ventas);
      tr.insertCell().textContent = usd(b.usd);
    });
    el.dashGrafico.appendChild(tabla);
    leerBarra(null);
  }

  /** Lectura de una barra (toque o paso del mouse); sin barra, el total del período. */
  function leerBarra(i) {
    Array.prototype.forEach.call(el.dashGrafico.querySelectorAll('[data-barra]'), function (g) {
      g.toggleAttribute('data-activa', Number(g.getAttribute('data-barra')) === i);
    });
    if (i == null || !dashBarras[i]) {
      poner(el.dashLectura, 'Toca una barra para ver su detalle.');
      return;
    }
    var b = dashBarras[i];
    poner(el.dashLectura, b.largo + ': ' + usd(b.usd) + ' · ' + plural(b.ventas, 'venta', 'ventas'));
  }

  function fila(lista, etiqueta, valor, detalle, fraccion, tono) {
    var li = document.createElement('li');
    li.className = 'dash-fila';
    li.innerHTML = '<span class="dash-fila-nombre"></span><span class="dash-fila-valor"></span>' +
      '<span class="dash-fila-barra"><span></span></span><span class="dash-fila-detalle"></span>';
    li.children[0].textContent = etiqueta;
    li.children[1].textContent = valor;
    li.children[2].firstChild.style.width = Math.round(Math.max(0, Math.min(1, fraccion)) * 100) + '%';
    if (tono) li.children[2].setAttribute('data-tono', tono);
    li.children[3].textContent = detalle;
    lista.appendChild(li);
  }

  function pintarMetodos(ventas, r) {
    var efectivo = 0, movil = 0, punto = 0;
    ventas.forEach(function (v) {
      var d = desglose(v);
      efectivo += d.efectivo - d.vueltoUsd;
      if (d.canal === 'punto') punto += d.restanteUsd; else movil += d.restanteUsd;
    });
    var total = Math.max(1, efectivo + movil + punto);
    el.dashMetodos.innerHTML = '';
    if (!r.cantidad) {
      var vacio = document.createElement('li');
      vacio.className = 'venta-vacia';
      vacio.textContent = 'Sin ventas en este período.';
      el.dashMetodos.appendChild(vacio);
      return;
    }
    [['Efectivo USD', efectivo, null], ['Pago Móvil', movil, 'bs'], ['Punto de venta', punto, 'bs']].forEach(function (m) {
      if (!m[1] && m[0] === 'Punto de venta') return;
      fila(el.dashMetodos, m[0], usd(m[1]), Math.round(m[1] / total * 100) + '%', m[1] / total, m[2]);
    });
  }

  function pintarTopProductos(ventas) {
    var por = {};
    ventas.forEach(function (v) {
      (v.items || []).forEach(function (it) {
        var k = it.productoId + '|' + it.nombre;
        if (!por[k]) por[k] = { nombre: it.nombre, cantidad: 0, usd: 0 };
        por[k].cantidad += it.cantidad;
        por[k].usd += Math.round(cent(it.precioUsd) * it.cantidad);
      });
    });
    var top = Object.keys(por).map(function (k) { return por[k]; })
      .sort(function (a, b) { return b.usd - a.usd; }).slice(0, 5);
    el.dashProductosBloque.hidden = !top.length;
    el.dashProductos.innerHTML = '';
    var max = top.length ? top[0].usd : 1;
    top.forEach(function (p) {
      fila(el.dashProductos, p.nombre, usd(p.usd), fmtCantidad(p.cantidad) + (p.cantidad === 1 ? ' unidad' : ' unidades'), p.usd / max);
    });
  }

  // ---------- Conexión ----------
  function actualizarConexion() {
    var online = navigator.onLine;
    if (el.estadoConexion) {
      el.estadoConexion.classList.toggle('online', online);
      el.estadoConexion.classList.toggle('offline', !online);
      el.estadoConexion.textContent = online ? 'En línea' : 'Sin conexión';
    }
    if (el.reciboNota) el.reciboNota.hidden = online;
  }

  /** Vibración corta al tocar teclas y billetes (Android; iOS no la ofrece y se ignora). */
  function vibrar() {
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* sin vibración */ } }
  }

  // ---------- Eventos ----------
  function enlazarEventos() {
    // En iOS Safari, :active solo se pinta al tocar si existe algún oyente de touchstart.
    document.addEventListener('touchstart', function () {}, { passive: true });
    // Tocar fuera del recuadro cierra cualquier modal.
    [el.tasas, el.historial, el.anular, el.cobroPm, el.verificar, el.productos].forEach(function (d) {
      if (d) d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    });
    if (el.tasas) {
      el.editarTasas.addEventListener('click', abrirTasas);
      el.tasasCerrar.addEventListener('click', function () { el.tasas.close(); });
      el.tasasForm.addEventListener('submit', guardarTasas);
    }
    if (el.ajustes) {
      el.ajustesForm.addEventListener('submit', guardarAjustes);
      el.ajusteLogo.addEventListener('change', elegirLogo);
      el.ajusteLogoQuitar.addEventListener('click', quitarLogo);
      Array.prototype.forEach.call(el.ajustesTemas, function (r) { r.addEventListener('change', elegirTema); });
      el.respaldoExportar.addEventListener('click', exportarRespaldo);
      el.respaldoImportar.addEventListener('change', elegirRespaldo);
      el.respaldoCancelar.addEventListener('click', cancelarImportacion);
      el.respaldoConfirmar.addEventListener('click', confirmarImportacion);
    }
    if (el.historial) {
      el.abrirHistorial.addEventListener('click', abrirHistorial);
      el.historialCerrar.addEventListener('click', function () { el.historial.close(); });
      el.historialVolver.addEventListener('click', function () { mostrarVistaHistorial(false); });
      el.historialLista.addEventListener('click', function (e) {
        var b = e.target.closest('[data-cierre]');
        if (b) verCierre(b.getAttribute('data-cierre'));
      });
    }
    if (el.anular) {
      el.anularCerrar.addEventListener('click', function () { el.anular.close(); });
      el.anularCancelar.addEventListener('click', function () { el.anular.close(); });
      el.anularConfirmar.addEventListener('click', confirmarAnulacion);
      el.anular.addEventListener('close', function () { ventaPorAnular = null; });
    }

    if (el.cobroPm) {
      el.cobroPmForm.addEventListener('submit', registrarCobroPM);
      el.cobroPmCerrar.addEventListener('click', function () { el.cobroPm.close(); });
      el.cobroPmCancelar.addEventListener('click', function () { el.cobroPm.close(); });
      el.cobroPm.addEventListener('close', function () { ventaPorCobrar = null; });
      el.cobroPmRef.addEventListener('input', evaluarRefCobro);
      el.cobroPmCopiar.addEventListener('click', copiarDatosPM);
      el.cobroPmIrAjustes.addEventListener('click', function () { el.cobroPm.close(); irA('ajustes'); el.ajustePmBanco.focus(); });
    }
    if (el.productos) {
      el.abrirProductos.addEventListener('click', abrirProductos);
      el.rejillaLista.addEventListener('click', function (e) {
        var mas = e.target.closest('[data-sumar]'), menos = e.target.closest('[data-restar-tile]');
        if (mas) sumarProducto(mas.getAttribute('data-sumar'), 1);
        else if (menos) sumarProducto(menos.getAttribute('data-restar-tile'), -1);
      });
      el.rejillaBuscar.addEventListener('input', pintarRejilla);
      el.rejillaInventario.addEventListener('click', function () { irA('inventario'); });
      el.invFoto.addEventListener('change', elegirFoto);
      el.invFotoQuitar.addEventListener('click', quitarFoto);
      el.actualizarTasas.addEventListener('click', function () { actualizarTasasSolas(true); });
      window.addEventListener('online', function () { actualizarTasasSolas(); });
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') actualizarTasasSolas(); });
      el.facturaEnviar.addEventListener('click', enviarFactura);
      el.facturaVer.addEventListener('click', verFactura);
      el.facturaOmitir.addEventListener('click', omitirFactura);
      el.facturaCorreo.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); enviarFactura(); } });
      el.carritoEditar.addEventListener('click', abrirProductos);
      el.carritoQuitar.addEventListener('click', quitarCarrito);
      el.productosCerrar.addEventListener('click', cerrarProductos);
      el.productosListo.addEventListener('click', cerrarProductos);
      el.productos.addEventListener('close', alCerrarProductos);
      el.productosBuscar.addEventListener('input', pintarElegir);
      el.productosIrEditar.addEventListener('click', irAInventario);
      el.productosCrearPrimero.addEventListener('click', irAInventario);
      el.invForm.addEventListener('submit', guardarProducto);
      el.invEliminar.addEventListener('click', eliminarProducto);
      el.productosLista.addEventListener('click', function (e) {
        var mas = e.target.closest('[data-agregar]');
        if (mas) { vibrar(); cambiarCantidad(mas.getAttribute('data-agregar'), 1); return; }
        var menos = e.target.closest('[data-restar]');
        if (menos) { vibrar(); cambiarCantidad(menos.getAttribute('data-restar'), -1); }
      });
      el.invLista.addEventListener('click', function (e) {
        var b = e.target.closest('[data-editar-producto]');
        if (b) editarProducto(b.getAttribute('data-editar-producto'));
      });
    }
    if (el.menu) {
      el.menu.addEventListener('click', function (e) {
        var b = e.target.closest('[data-vista]');
        if (b) { vibrar(); irA(b.getAttribute('data-vista')); }
      });
    }
    if (el.vistaPortada) {
      [el.irIngresar, el.portadaIngresar].forEach(function (b) { b.addEventListener('click', function () { irA('ingresar'); }); });
      [el.irCrear, el.portadaCrear, el.ingresarIrCrear].forEach(function (b) { b.addEventListener('click', irACrear); });
      el.ingresarForm.addEventListener('submit', ingresar);
      el.cerrarSesion.addEventListener('click', cerrarSesion);
      el.marcaNombre.closest('.marca').addEventListener('click', function () { if (el.menu.hidden && vistaActual !== 'portada') irA('portada'); });
    }
    if (el.vistaRegistro) {
      el.registroForm.addEventListener('submit', crearCuenta);
      el.registroLogo.addEventListener('change', elegirLogoRegistro);
    }
    if (el.vistaResumen) {
      el.dashboardPeriodos.addEventListener('click', function (e) {
        var b = e.target.closest('[data-periodo]');
        if (b) { estado.dashPeriodo = b.getAttribute('data-periodo'); pintarDashboard(); }
      });
      el.dashGrafico.addEventListener('click', function (e) {
        var g = e.target.closest('[data-barra]');
        leerBarra(g ? Number(g.getAttribute('data-barra')) : null);
      });
      el.dashGrafico.addEventListener('mouseover', function (e) {
        var g = e.target.closest('[data-barra]');
        if (g) leerBarra(Number(g.getAttribute('data-barra')));
      });
    }
    if (el.verificar) {
      el.abrirVerificar.addEventListener('click', function () { abrirVerificar(); });
      el.reciboVerificar.addEventListener('click', function () { if (estado.recibo) abrirVerificar({ ventaId: estado.recibo.id }); });
      el.verificarCerrar.addEventListener('click', function () { el.verificar.close(); });
      el.verificarProcesar.addEventListener('click', procesarSMS);
      el.verificarPegar.addEventListener('click', pegarSMS);
      el.verificarManual.addEventListener('click', function () { if (ventaAVerificar) verificarYMostrar(ventaAVerificar.id, null); });
      el.verificarOpciones.addEventListener('click', function (e) {
        var b = e.target.closest('[data-verificar-venta]');
        if (b) verificarYMostrar(Number(b.getAttribute('data-verificar-venta')), b.getAttribute('data-verificar-ref'));
      });
    }

    if (el.totalUsd) el.totalUsd.addEventListener('click', function () { activarCampo('total'); });
    if (el.recibidoUsd) el.recibidoUsd.addEventListener('click', function () { activarCampo('recibido'); });

    // Delegación: teclado numérico y billetes
    document.addEventListener('click', function (e) {
      var tecla = e.target.closest('[data-key]');
      if (tecla) { vibrar(); teclear(tecla.getAttribute('data-key')); return; }
      var billete = e.target.closest('[data-billete]');
      if (billete) { vibrar(); sumarBillete(billete.getAttribute('data-billete')); return; }
      var canal = e.target.closest('[data-canal]');
      if (canal) { vibrar(); elegirCanal(canal.getAttribute('data-canal')); return; }
      var verificar = e.target.closest('[data-verificar]');
      if (verificar) { abrirVerificar({ ventaId: verificar.getAttribute('data-verificar') }); return; }
      var anular = e.target.closest('[data-anular]');
      if (anular) pedirAnulacion(anular.getAttribute('data-anular'));
    });

    // Teclado físico (útil en escritorio o con teclado bluetooth)
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !t.readOnly))) return; // campos de texto
      if (document.querySelector('dialog[open]')) return; // los modales manejan su propio teclado (Esc los cierra)
      if (vistaActual !== 'caja') return;
      var k = e.key;
      if (/^[0-9]$/.test(k)) teclear(k);
      else if (k === '.' || k === ',') teclear('.');
      else if (k === 'Backspace') teclear('borrar');
      else if (k === 'Escape') teclear('limpiar');
      else if (k === 'Tab') { e.preventDefault(); activarCampo(estado.campoActivo === 'total' ? 'recibido' : 'total'); }
      else if (k === 'Enter') {
        // Enter sobre un botón o enlace (p. ej. WhatsApp) conserva su acción normal.
        if (e.target.closest && e.target.closest('button, a')) return;
        cobrar();
      }
      else return;
      e.preventDefault();
    });

    if (el.registrar) el.registrar.addEventListener('click', cobrar);
    if (el.nuevaVenta) el.nuevaVenta.addEventListener('click', function () {
      ocultarRecibo();
      limpiarFormulario();
      if (el.totalUsd && el.totalUsd.scrollIntoView) el.totalUsd.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    if (el.abrirCierre) el.abrirCierre.addEventListener('click', abrirCierre);
    if (el.cierre) {
      el.cierreCerrar.addEventListener('click', cerrarModalCierre);
      el.cierreArchivar.addEventListener('click', function () { mostrarConfirmacion(true); });
      el.cierreCancelar.addEventListener('click', function () { mostrarConfirmacion(false); el.cierreArchivar.focus(); });
      el.cierreConfirmar.addEventListener('click', limpiarCaja);
      el.cierreWhatsapp.addEventListener('click', function (e) {
        if (el.cierreWhatsapp.getAttribute('aria-disabled') === 'true') e.preventDefault();
      });
      // Tocar fuera del recuadro cierra el modal.
      el.cierre.addEventListener('click', function (e) { if (e.target === el.cierre) cerrarModalCierre(); });
      el.cierre.addEventListener('close', function () { mostrarConfirmacion(false); });
    }

    window.addEventListener('online', actualizarConexion);
    window.addEventListener('offline', actualizarConexion);
  }

  // ---------- Service Worker ----------
  function registrarSW() {
    if (!('serviceWorker' in navigator)) return;
    // Si ya había un SW controlando la página, un cambio de controlador = versión nueva instalada.
    // El SW nuevo ya borró las cachés viejas; recargar carga los archivos nuevos. No se recarga
    // solo para no perder una venta a medio teclear: se ofrece un aviso con botón.
    var habiaControlador = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!habiaControlador) { habiaControlador = true; return; }
      var aviso = document.getElementById('nueva-version');
      if (aviso) aviso.hidden = false;
    });
    var recargar = document.getElementById('nueva-version-recargar');
    if (recargar) recargar.addEventListener('click', function () { location.reload(); });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // Una PWA instalada puede pasar días sin navegar: busca versión nueva al volver a primer plano.
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(function () {});
        });
      }).catch(function (e) {
        console.warn('[Cuadre] No se pudo registrar el Service Worker:', e);
      });
    });
  }

  // ---------- Inicio ----------
  function iniciar() {
    el = {
      marcaLogo: $('#marca-logo'),
      marcaNombre: $('#marca-nombre'),
      tasaActual: $('#tasa-actual'),
      tasaFecha: $('#tasa-fecha'),
      tasaEur: $('#tasa-eur'),
      tasaEurFecha: $('#tasa-eur-fecha'),
      tasaParalelo: $('#tasa-paralelo'),
      tasaParaleloFecha: $('#tasa-paralelo-fecha'),
      editarTasas: $('#editar-tasas'),
      tasas: $('#tasas'),
      tasasForm: $('#tasas-form'),
      tasasCerrar: $('#tasas-cerrar'),
      tasasMensaje: $('#tasas-mensaje'),
      tasaInput: $('#tasa-input'),
      tasaEurInput: $('#tasa-eur-input'),
      tasaParaleloInput: $('#tasa-paralelo-input'),
      tasaGuardar: $('#tasa-guardar'),
      ajustes: $('#vista-ajustes'),
      ajustePaleta: $('#ajuste-paleta'),
      temaLogoOpcion: $('#tema-logo-opcion'),
      temaLogoMuestra: $('#tema-logo-muestra'),
      vistaCaja: $('#vista-caja'),
      vistaResumen: $('#vista-resumen'),
      vistaInventario: $('#vista-inventario'),
      vistaAjustes: $('#vista-ajustes'),
      vistaRegistro: $('#vista-registro'),
      menu: $('#menu'),
      registroForm: $('#registro-form'),
      registroLogo: $('#registro-logo'),
      registroLogoVista: $('#registro-logo-vista'),
      registroLogoVacio: $('#registro-logo-vacio'),
      registroPaleta: $('#registro-paleta'),
      registroNombre: $('#registro-nombre'),
      registroContacto: $('#registro-contacto'),
      registroTasa: $('#registro-tasa'),
      registroPmBanco: $('#registro-pm-banco'),
      registroPmTelefono: $('#registro-pm-telefono'),
      registroPmDocumento: $('#registro-pm-documento'),
      registroMensaje: $('#registro-mensaje'),
      registroCrear: $('#registro-crear'),
      registroPin: $('#registro-pin'),
      ajustePin: $('#ajuste-pin'),
      cerrarSesion: $('#cerrar-sesion'),
      acceso: $('#acceso'),
      irIngresar: $('#ir-ingresar'),
      irCrear: $('#ir-crear'),
      vistaPortada: $('#vista-portada'),
      portadaCrear: $('#portada-crear'),
      portadaIngresar: $('#portada-ingresar'),
      vistaIngresar: $('#vista-ingresar'),
      ingresarForm: $('#ingresar-form'),
      ingresarNota: $('#ingresar-nota'),
      ingresarCuenta: $('#ingresar-cuenta'),
      ingresarLogo: $('#ingresar-logo'),
      ingresarNombre: $('#ingresar-nombre'),
      ingresarPinCampo: $('#ingresar-pin-campo'),
      ingresarPin: $('#ingresar-pin'),
      ingresarMensaje: $('#ingresar-mensaje'),
      ingresarEntrar: $('#ingresar-entrar'),
      ingresarSinCuenta: $('#ingresar-sin-cuenta'),
      ingresarIrCrear: $('#ingresar-ir-crear'),
      ajustesForm: $('#ajustes-form'),
      ajusteNombre: $('#ajuste-nombre'),
      ajusteContacto: $('#ajuste-contacto'),
      ajusteLogo: $('#ajuste-logo'),
      ajusteLogoVista: $('#ajuste-logo-vista'),
      ajusteLogoVacio: $('#ajuste-logo-vacio'),
      ajusteLogoQuitar: $('#ajuste-logo-quitar'),
      ajustesTemas: document.querySelectorAll('#vista-ajustes input[name="tema"]'),
      ajustePmBanco: $('#ajuste-pm-banco'),
      ajustePmTelefono: $('#ajuste-pm-telefono'),
      ajustePmDocumento: $('#ajuste-pm-documento'),
      canalBs: $('#canal-bs'),
      abrirProductos: $('#abrir-productos'),
      carrito: $('#carrito'),
      carritoResumen: $('#carrito-resumen'),
      carritoEditar: $('#carrito-editar'),
      carritoQuitar: $('#carrito-quitar'),
      productos: $('#productos'),
      productosTitulo: $('#productos-titulo'),
      productosNota: $('#productos-nota'),
      productosCerrar: $('#productos-cerrar'),
      productosVistaElegir: $('#productos-vista-elegir'),
      productosBuscar: $('#productos-buscar'),
      productosLista: $('#productos-lista'),
      productosVacio: $('#productos-vacio'),
      productosCrearPrimero: $('#productos-crear-primero'),
      productosIrEditar: $('#productos-ir-editar'),
      productosAcciones: $('#productos-acciones'),
      productosTotal: $('#productos-total'),
      productosListo: $('#productos-listo'),
      invForm: $('#inv-form'),
      invFormTitulo: $('#inv-form-titulo'),
      invNombre: $('#inv-nombre'),
      invPrecio: $('#inv-precio'),
      invStock: $('#inv-stock'),
      invMensaje: $('#inv-mensaje'),
      invEliminar: $('#inv-eliminar'),
      invGuardar: $('#inv-guardar'),
      invLista: $('#inv-lista'),
      invFoto: $('#inv-foto'),
      invFotoVista: $('#inv-foto-vista'),
      invFotoVacio: $('#inv-foto-vacio'),
      invFotoQuitar: $('#inv-foto-quitar'),
      rejilla: $('#rejilla'),
      rejillaLista: $('#rejilla-lista'),
      rejillaBuscar: $('#rejilla-buscar'),
      rejillaInventario: $('#rejilla-inventario'),
      tasasEstado: $('#tasas-estado'),
      actualizarTasas: $('#actualizar-tasas'),
      factura: $('#factura'),
      facturaCorreo: $('#factura-correo'),
      facturaEnviar: $('#factura-enviar'),
      facturaVer: $('#factura-ver'),
      facturaOmitir: $('#factura-omitir'),
      facturaMensaje: $('#factura-mensaje'),
      dashboardPeriodo: $('#dashboard-periodo'),
      dashboardPeriodos: $('#dashboard-periodos'),
      dashKpis: $('#dash-kpis'),
      dashGraficoTitulo: $('#dash-grafico-titulo'),
      dashGrafico: $('#dash-grafico'),
      dashLectura: $('#dash-lectura'),
      dashMetodos: $('#dash-metodos'),
      dashProductosBloque: $('#dash-productos-bloque'),
      dashProductos: $('#dash-productos'),
      cobroPm: $('#cobro-pm'),
      cobroPmForm: $('#cobro-pm-form'),
      cobroPmCerrar: $('#cobro-pm-cerrar'),
      cobroPmMonto: $('#cobro-pm-monto'),
      cobroPmEquivale: $('#cobro-pm-equivale'),
      cobroPmDatos: $('#cobro-pm-datos'),
      cobroPmBotones: $('#cobro-pm-botones'),
      cobroPmCopiar: $('#cobro-pm-copiar'),
      cobroPmWhatsapp: $('#cobro-pm-whatsapp'),
      cobroPmSinDatos: $('#cobro-pm-sin-datos'),
      cobroPmIrAjustes: $('#cobro-pm-ir-ajustes'),
      cobroPmRef: $('#cobro-pm-ref'),
      cobroPmEstado: $('#cobro-pm-estado'),
      cobroPmCancelar: $('#cobro-pm-cancelar'),
      cobroPmRegistrar: $('#cobro-pm-registrar'),
      abrirVerificar: $('#abrir-verificar'),
      reciboVerificar: $('#recibo-verificar'),
      verificar: $('#verificar'),
      verificarCerrar: $('#verificar-cerrar'),
      verificarVenta: $('#verificar-venta'),
      verificarTexto: $('#verificar-texto'),
      verificarPegar: $('#verificar-pegar'),
      verificarProcesar: $('#verificar-procesar'),
      verificarResultado: $('#verificar-resultado'),
      verificarOpciones: $('#verificar-opciones'),
      verificarPendientes: $('#verificar-pendientes'),
      verificarLista: $('#verificar-lista'),
      verificarManual: $('#verificar-manual'),
      cierreAvisoVerificar: $('#cierre-aviso-verificar'),
      ajustesMensaje: $('#ajustes-mensaje'),
      ajustesGuardar: $('#ajustes-guardar'),
      totalUsd: $('#total-usd'),
      recibidoUsd: $('#recibido-usd'),
      totalBs: $('#total-bs'),
      resultado: $('#resultado'),
      resultadoTitulo: $('#resultado-titulo'),
      resultadoPrincipal: $('#resultado-principal'),
      resultadoSecundario: $('#resultado-secundario'),
      aviso: $('#aviso'),
      registrar: $('#registrar-venta'),
      recibo: $('#recibo'),
      reciboDetalle: $('#recibo-detalle'),
      reciboMetodo: $('#recibo-metodo'),
      reciboComercio: $('#recibo-comercio'),
      reciboLogo: $('#recibo-logo'),
      reciboNombre: $('#recibo-nombre'),
      reciboContacto: $('#recibo-contacto'),
      reciboNota: $('#recibo-nota'),
      whatsapp: $('#enviar-whatsapp'),
      nuevaVenta: $('#nueva-venta'),
      ventasLista: $('#ventas-lista'),
      ventasResumen: $('#ventas-resumen'),
      estadoConexion: $('#estado-conexion'),
      abrirCierre: $('#abrir-cierre'),
      cierre: $('#cierre'),
      cierrePeriodo: $('#cierre-periodo'),
      cierreCerrar: $('#cierre-cerrar'),
      cierreCantidad: $('#cierre-cantidad'),
      cierreCantidadDetalle: $('#cierre-cantidad-detalle'),
      cierreEfectivo: $('#cierre-efectivo'),
      cierreEfectivoDetalle: $('#cierre-efectivo-detalle'),
      cierreBanco: $('#cierre-banco'),
      cierreBancoDetalle: $('#cierre-banco-detalle'),
      cierreTotal: $('#cierre-total'),
      cierreTotalDetalle: $('#cierre-total-detalle'),
      cierreMensaje: $('#cierre-mensaje'),
      cierreAcciones: $('#cierre-acciones'),
      cierreWhatsapp: $('#cierre-whatsapp'),
      cierreArchivar: $('#cierre-archivar'),
      cierreConfirmacion: $('#cierre-confirmacion'),
      cierreCancelar: $('#cierre-cancelar'),
      cierreConfirmar: $('#cierre-confirmar'),
      cierreAvisoDias: $('#cierre-aviso-dias'),
      cierreAnuladas: $('#cierre-anuladas'),
      abrirHistorial: $('#abrir-historial'),
      historial: $('#historial'),
      historialNota: $('#historial-nota'),
      historialCerrar: $('#historial-cerrar'),
      historialVistaLista: $('#historial-vista-lista'),
      historialLista: $('#historial-lista'),
      historialVistaDetalle: $('#historial-vista-detalle'),
      historialVolver: $('#historial-volver'),
      historialDetalle: $('#historial-detalle'),
      historialWhatsapp: $('#historial-whatsapp'),
      anular: $('#anular'),
      anularCerrar: $('#anular-cerrar'),
      anularDetalle: $('#anular-detalle'),
      anularMensaje: $('#anular-mensaje'),
      anularCancelar: $('#anular-cancelar'),
      anularConfirmar: $('#anular-confirmar'),
      respaldoExportar: $('#respaldo-exportar'),
      respaldoImportar: $('#respaldo-importar'),
      respaldoMensaje: $('#respaldo-mensaje'),
      respaldoConfirmacion: $('#respaldo-confirmacion'),
      respaldoConfirmacionTexto: $('#respaldo-confirmacion-texto'),
      respaldoCancelar: $('#respaldo-cancelar'),
      respaldoConfirmar: $('#respaldo-confirmar')
    };

    [el.ajustePmBanco, el.registroPmBanco].forEach(function (sel) {
      if (!sel || !PM) return;
      PM.BANCOS.forEach(function (b) {
        var o = document.createElement('option');
        o.value = b[0];
        o.textContent = b[0] + ' · ' + b[1];
        sel.appendChild(o);
      });
    });

    enlazarEventos();
    actualizarConexion();
    activarCampo('total');
    mostrarTasa();
    recalcular();

    if (!DB || !PM) {
      irA('caja');
      avisar('Error: no se cargaron todos los archivos de la app. Recarga la página.');
      return;
    }

    cargarDatos().then(function () {
      if (vistaActual === 'caja') revisarCompartido();
    }).catch(function (e) {
      console.error(e);
      irA('caja');
      avisar('No se pudo abrir el almacenamiento local.');
    });
  }

  /** Lee tasas, ajustes y ventas de IndexedDB y pinta la pantalla (al iniciar y tras importar un respaldo). */
  var arranque = true; // la primera carga decide la vista; tras importar un respaldo se queda donde está

  function cargarDatos() {
    return DB.abrir()
      .then(function () { return Promise.all([DB.obtenerTasas(), DB.obtenerAjustes()]); })
      .then(function (res) {
        var t = res[0], a = res[1];
        estado.tasa = t.bcv;
        estado.tasasRef = { eur: t.eur, paralelo: t.paralelo };
        estado.comercio = a;
        // IndexedDB manda: si la copia de localStorage se perdió o difiere, se corrige aquí.
        if (a.tema) aplicarTema(a.tema, a.colores);
        pintarMarca();
        // Sin cuenta o con la sesión cerrada: portada. Quien ya tenía nombre (versiones anteriores) entra directo.
        var afuera = ['portada', 'ingresar', 'registro'].indexOf(vistaActual) !== -1;
        if (arranque || afuera) irA(vistaInicial());
        arranque = false;
        mostrarTasa();
        recalcular();
        actualizarTasasSolas();
        return Promise.all([renderVentas(), refrescarCatalogo()]);
      });
  }

  registrarSW();
  // Pide almacenamiento persistente para que el navegador no borre IndexedDB (las ventas)
  // cuando el teléfono se queda sin espacio. No muestra ningún aviso al usuario.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  // Expuesto para pruebas
  window.CuadreApp = {
    aCentavos: aCentavos, aBsCentavos: aBsCentavos, parsearTasa: parsearTasa,
    calcular: calcular, mensajeWhatsApp: mensajeWhatsApp, enlaceWhatsApp: enlaceWhatsApp, lineasRecibo: lineasRecibo,
    resumirCierre: resumirCierre, mensajeCierre: mensajeCierre, cierreACentavos: cierreACentavos,
    procesarSMS: procesarSMS, abrirVerificar: abrirVerificar
  };
})();
