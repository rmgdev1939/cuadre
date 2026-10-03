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
 *
 * Todos los montos se manejan en centavos enteros para evitar errores de coma
 * flotante; solo se convierten a decimales al mostrarlos o guardarlos.
 */
(function () {
  'use strict';

  var DB = window.CuadreDB;
  var MAX_DIGITOS_ENTEROS = 7;

  // ---------- Estado ----------
  var estado = {
    tasa: null,              // tasa BCV USD { valor, fecha } o null
    tasasRef: { eur: null, paralelo: null }, // tasas de referencia { valor, fecha } o null
    comercio: { nombre: '', contacto: '', logo: null, tema: null },
    campoActivo: 'total',    // 'total' | 'recibido' (efectivo USD)
    entrada: { total: '', recibido: '' }, // texto tecleado, p. ej. "12.5"
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
      poner(el.tasaFecha, 'Actualizada: ' + fmtFecha.format(new Date(estado.tasa.fecha)));
    } else {
      poner(el.tasaActual, 'Sin tasa');
      poner(el.tasaFecha, 'Toca «Editar Tasas» para ingresar la tasa BCV del día');
    }
    [['eur', el.tasaEur, el.tasaEurFecha], ['paralelo', el.tasaParalelo, el.tasaParaleloFecha]].forEach(function (x) {
      var t = estado.tasasRef[x[0]];
      poner(x[1], t ? 'Bs ' + fmtTasa.format(t.valor) : '—');
      poner(x[2], t ? fmtFechaCorta.format(new Date(t.fecha)) : 'Sin registrar');
    });
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

  // ---------- Ajustes del comercio (marca y tema) ----------
  var COLOR_BARRA = { esmeralda: '#047857', azul: '#1e40af', naranja: '#c2410c', oscuro: '#151f1e' };
  var LOGO_MAX_PX = 256;
  var LOGO_MAX_BYTES = 10 * 1024 * 1024;
  var logoPendiente; // undefined = sin cambios · null = quitar · string = nuevo logo (data URL)

  function temaActual() {
    return document.documentElement.getAttribute('data-tema') || 'esmeralda';
  }

  /** Aplica el tema al instante y deja una copia en localStorage para pintarlo antes de que cargue IndexedDB. */
  function aplicarTema(tema) {
    if (!COLOR_BARRA[tema]) return;
    document.documentElement.setAttribute('data-tema', tema);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLOR_BARRA[tema]);
    try { localStorage.setItem('cuadre-tema', tema); } catch (e) { /* modo privado: no pasa nada */ }
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

  function mensajeAjustes(texto) {
    el.ajustesMensaje.textContent = texto || '';
    el.ajustesMensaje.hidden = !texto;
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

  function abrirAjustes() {
    if (!el.ajustes) return;
    var c = estado.comercio;
    el.ajusteNombre.value = c.nombre || '';
    el.ajusteContacto.value = c.contacto || '';
    el.ajusteLogo.value = '';
    logoPendiente = undefined;
    vistaLogo(c.logo);
    var tema = temaActual();
    Array.prototype.forEach.call(el.ajustesTemas, function (r) { r.checked = r.value === tema; });
    mensajeAjustes('');
    respaldoPendiente = null;
    mostrarConfirmacionRespaldo('');
    mensajeRespaldo('');
    if (!el.ajustes.open) el.ajustes.showModal();
    el.ajustesCerrar.focus();
  }

  function elegirLogo() {
    var archivo = el.ajusteLogo.files && el.ajusteLogo.files[0];
    if (!archivo) return;
    mensajeAjustes('');
    procesarLogo(archivo).then(function (dataUrl) {
      logoPendiente = dataUrl;
      vistaLogo(dataUrl);
    }).catch(function (e) {
      mensajeAjustes(e.message);
    }).then(function () {
      el.ajusteLogo.value = '';
    });
  }

  function quitarLogo() {
    logoPendiente = null;
    vistaLogo(null);
  }

  /** El tema se aplica y se guarda al tocarlo, sin esperar a "Guardar ajustes". */
  function elegirTema(e) {
    var tema = e.target.value;
    aplicarTema(tema);
    DB.guardarAjustes({ tema: tema }).then(function (a) {
      estado.comercio.tema = a.tema;
    }).catch(function (err) {
      console.error(err);
      mensajeAjustes('No se pudo guardar el tema.');
    });
  }

  function guardarAjustes(e) {
    if (e) e.preventDefault();
    var cambios = { nombre: el.ajusteNombre.value, contacto: el.ajusteContacto.value };
    if (logoPendiente !== undefined) cambios.logo = logoPendiente;
    el.ajustesGuardar.disabled = true;
    DB.guardarAjustes(cambios).then(function (a) {
      estado.comercio = a;
      logoPendiente = undefined;
      pintarMarca();
      if (estado.recibo) mostrarRecibo(estado.recibo, true);
      el.ajustes.close();
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

  /** 'efectivo' | 'mixto' | 'pago-movil', según cómo se pagó. */
  function metodoDePago(r) {
    if (r.restanteUsd === 0) return 'efectivo';
    return r.efectivo > 0 ? 'mixto' : 'pago-movil';
  }

  var NOMBRE_METODO = { efectivo: 'Efectivo USD', mixto: 'Pago mixto', 'pago-movil': 'Pago Móvil' };

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
      titulo = r.efectivo > 0 ? 'Restante a cobrar en Bs · Pago Móvil' : 'Total a cobrar en Bs · Pago Móvil';
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
    registrando = true;
    if (el.registrar) el.registrar.disabled = true;

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

    DB.registrarVenta(venta).then(function (id) {
      venta.id = id;
      limpiarFormulario();
      mostrarRecibo(venta);
      return renderVentas();
    }).catch(function (e) {
      console.error(e);
      avisar('No se pudo registrar la venta. Intenta de nuevo.');
    }).then(function () {
      registrando = false;
      recalcular();
    });
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
      metodo: v.metodo || 'efectivo'
    };
  }

  /** Líneas [etiqueta, valor] del resumen, compartidas por la pantalla y WhatsApp. */
  function lineasRecibo(v) {
    var d = desglose(v);
    var lineas = [
      ['Fecha', fmtFechaRecibo.format(new Date(v.fecha))],
      ['Total USD', usd(d.totalUsd)],
      ['Tasa BCV', 'Bs ' + fmtTasa.format(v.tasa) + ' por USD']
    ];
    if (v.tasaEur) lineas.push(['Tasa EUR', 'Bs ' + fmtTasa.format(v.tasaEur) + ' por EUR']);
    if (v.tasaParalelo) lineas.push(['Tasa Paralelo', 'Bs ' + fmtTasa.format(v.tasaParalelo) + ' por USD']);
    lineas.push(['Total en Bs', bs(d.totalBs)]);
    if (d.efectivo > 0) lineas.push(['Pagado en USD (efectivo)', usd(d.efectivo)]);
    if (d.restanteBs > 0) lineas.push(['Pagado en Bs (Pago Móvil)', bs(d.restanteBs)]);
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
    el.reciboDetalle.innerHTML = '';
    lineasRecibo(v).forEach(function (l) {
      var dt = document.createElement('dt');
      var dd = document.createElement('dd');
      dt.textContent = l[0];
      dd.textContent = l[1];
      el.reciboDetalle.appendChild(dt);
      el.reciboDetalle.appendChild(dd);
    });
    var metodo = desglose(v).metodo;
    poner(el.reciboMetodo, NOMBRE_METODO[metodo] || '');
    el.reciboMetodo.setAttribute('data-metodo', metodo);
    el.whatsapp.href = enlaceWhatsApp(v);
    actualizarConexion();
    el.recibo.hidden = false;
    // En teléfono, lleva el recibo a la vista para que el botón de WhatsApp quede a mano.
    if (!sinDesplazar && el.recibo.scrollIntoView) el.recibo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    if (d.restanteBs > 0) partes.push('Pago Móvil ' + bs(d.restanteBs));
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
          if (v.anuladaEn) {
            var insignia = document.createElement('span');
            insignia.className = 'insignia-anulada';
            insignia.innerHTML = 'Anulada<small></small>';
            insignia.lastChild.textContent = fmtHora.format(new Date(v.anuladaEn));
            li.children[2].appendChild(insignia);
          } else {
            var boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'boton boton-anular';
            boton.setAttribute('data-anular', String(v.id));
            boton.setAttribute('aria-label', 'Anular la venta de las ' + fmtHora.format(new Date(v.fecha)) + ' por ' + usd(d.totalUsd));
            boton.textContent = 'Anular';
            li.children[2].appendChild(boton);
          }
          li.children[3].textContent = detalleVenta(d);
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
      mensajeAnular('');
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
      metodos: { efectivo: 0, mixto: 0, 'pago-movil': 0 },
      recibidoUsd: 0, vueltoUsd: 0, efectivoUsd: 0,
      bancoBs: 0, bancoUsd: 0,
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
    return partes.join(' · ');
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
      '*Banco / Pago Móvil:* ' + bs(r.bancoBs),
      '  Equivale a ' + usd(r.bancoUsd),
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
    poner(el.cierreBancoDetalle, 'Equivale a ' + usd(r.bancoUsd));
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
      metodos: Object.assign({ efectivo: 0, mixto: 0, 'pago-movil': 0 }, c.metodos || {}),
      desde: c.desde || null, hasta: c.hasta || null
    };
    ['recibidoUsd', 'vueltoUsd', 'efectivoUsd', 'bancoBs', 'bancoUsd', 'totalUsd', 'totalBs'].forEach(function (k) {
      r[k] = cent(c[k]);
    });
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
      ['Banco · Pago Móvil', bs(r.bancoBs)],
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
    [el.tasas, el.ajustes, el.historial, el.anular].forEach(function (d) {
      if (d) d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    });
    if (el.tasas) {
      el.editarTasas.addEventListener('click', abrirTasas);
      el.tasasCerrar.addEventListener('click', function () { el.tasas.close(); });
      el.tasasForm.addEventListener('submit', guardarTasas);
    }
    if (el.ajustes) {
      el.abrirAjustes.addEventListener('click', abrirAjustes);
      el.ajustesCerrar.addEventListener('click', function () { el.ajustes.close(); });
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

    if (el.totalUsd) el.totalUsd.addEventListener('click', function () { activarCampo('total'); });
    if (el.recibidoUsd) el.recibidoUsd.addEventListener('click', function () { activarCampo('recibido'); });

    // Delegación: teclado numérico y billetes
    document.addEventListener('click', function (e) {
      var tecla = e.target.closest('[data-key]');
      if (tecla) { vibrar(); teclear(tecla.getAttribute('data-key')); return; }
      var billete = e.target.closest('[data-billete]');
      if (billete) { vibrar(); sumarBillete(billete.getAttribute('data-billete')); return; }
      var anular = e.target.closest('[data-anular]');
      if (anular) pedirAnulacion(anular.getAttribute('data-anular'));
    });

    // Teclado físico (útil en escritorio o con teclado bluetooth)
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !t.readOnly))) return; // campos de texto
      if (document.querySelector('dialog[open]')) return; // los modales manejan su propio teclado (Esc los cierra)
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
      abrirAjustes: $('#abrir-ajustes'),
      ajustes: $('#ajustes'),
      ajustesForm: $('#ajustes-form'),
      ajustesCerrar: $('#ajustes-cerrar'),
      ajusteNombre: $('#ajuste-nombre'),
      ajusteContacto: $('#ajuste-contacto'),
      ajusteLogo: $('#ajuste-logo'),
      ajusteLogoVista: $('#ajuste-logo-vista'),
      ajusteLogoVacio: $('#ajuste-logo-vacio'),
      ajusteLogoQuitar: $('#ajuste-logo-quitar'),
      ajustesTemas: document.querySelectorAll('#ajustes input[name="tema"]'),
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

    enlazarEventos();
    actualizarConexion();
    activarCampo('total');
    mostrarTasa();
    recalcular();

    if (!DB) {
      avisar('Error: no se cargó db.js.');
      return;
    }

    cargarDatos().catch(function (e) {
      console.error(e);
      avisar('No se pudo abrir el almacenamiento local.');
    });
  }

  /** Lee tasas, ajustes y ventas de IndexedDB y pinta la pantalla (al iniciar y tras importar un respaldo). */
  function cargarDatos() {
    return DB.abrir()
      .then(function () { return Promise.all([DB.obtenerTasas(), DB.obtenerAjustes()]); })
      .then(function (res) {
        var t = res[0], a = res[1];
        estado.tasa = t.bcv;
        estado.tasasRef = { eur: t.eur, paralelo: t.paralelo };
        estado.comercio = a;
        // IndexedDB manda: si la copia de localStorage se perdió o difiere, se corrige aquí.
        if (a.tema && a.tema !== temaActual()) aplicarTema(a.tema);
        pintarMarca();
        mostrarTasa();
        recalcular();
        return renderVentas();
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
    resumirCierre: resumirCierre, mensajeCierre: mensajeCierre, cierreACentavos: cierreACentavos
  };
})();
