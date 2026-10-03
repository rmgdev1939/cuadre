/*
 * CUADRE · pagomovil.js
 * Lector de SMS y notificaciones de Pago Móvil, sin conexión y sin servidor.
 * El comerciante comparte (o pega) el mensaje que SU banco le envía al recibir un pago;
 * de ahí se sacan el monto en Bs y la referencia para emparejarlo con una venta.
 * No se usa la captura del cliente: es fácil de falsificar.
 *
 * Expone window.CuadrePM con funciones puras (sin DOM ni IndexedDB).
 * Los montos van en centavos enteros, como en app.js.
 */
(function () {
  'use strict';

  /** Bancos venezolanos con su código, para los datos de Pago Móvil del comercio. */
  var BANCOS = [
    ['0102', 'Banco de Venezuela'],
    ['0104', 'Venezolano de Crédito'],
    ['0105', 'Mercantil'],
    ['0108', 'Provincial'],
    ['0114', 'Bancaribe'],
    ['0115', 'Exterior'],
    ['0128', 'Caroní'],
    ['0134', 'Banesco'],
    ['0137', 'Sofitasa'],
    ['0138', 'Plaza'],
    ['0151', 'BFC'],
    ['0156', '100% Banco'],
    ['0163', 'Banco del Tesoro'],
    ['0166', 'Banco Agrícola'],
    ['0168', 'Bancrecer'],
    ['0169', 'R4 Mi Banco'],
    ['0171', 'Banco Activo'],
    ['0172', 'Bancamiga'],
    ['0174', 'Banplus'],
    ['0175', 'Banco Digital de los Trabajadores'],
    ['0177', 'Banfanb'],
    ['0191', 'BNC']
  ];

  function nombreBanco(codigo) {
    for (var i = 0; i < BANCOS.length; i++) if (BANCOS[i][0] === codigo) return BANCOS[i][1];
    return '';
  }

  /**
   * "1.250,00" · "1250,00" · "1,250.00" · "1250.5" · "1250" → centavos. NaN si no es un monto.
   * El último separador seguido de 1 o 2 dígitos es el decimal; los demás son de miles.
   */
  function montoACentavos(texto) {
    var t = String(texto || '').replace(/\s/g, '');
    if (!/^\d[\d.,]*$/.test(t)) return NaN;
    var m = t.match(/^(.*?)[.,](\d{1,2})$/);
    var enteros = m ? m[1] : t;
    var dec = m ? (m[2] + '0').slice(0, 2) : '00';
    enteros = enteros.replace(/[.,]/g, '');
    if (!/^\d+$/.test(enteros)) return NaN;
    return parseInt(enteros, 10) * 100 + parseInt(dec, 10);
  }

  var NUM = '(\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  // Monto junto a "Bs", "Bs.", "Bs.S", "VES" o tras "monto"/"por".
  var RE_MONTOS = [
    new RegExp('(?:bs\\.?\\s*s?\\.?|ves)\\s*:?\\s*' + NUM, 'i'),
    new RegExp(NUM + '\\s*(?:bs\\b|bs\\.|ves\\b)', 'i'),
    new RegExp('monto\\s*(?:de\\s*)?(?:bs\\.?\\s*)?:?\\s*' + NUM, 'i'),
    new RegExp('\\bpor\\s+(?:un\\s+monto\\s+de\\s+)?' + NUM, 'i')
  ];
  // Referencia con etiqueta: "Ref: 123", "Ref.123", "Referencia 000123", "Nro. de operación 123", "Comprobante 123".
  var RE_REFERENCIA = /(?:\bref(?:erencia)?\b|\bnro\.?\s*(?:de\s*)?(?:operaci[oó]n|referencia)|\bn[°º]\s*(?:de\s*)?(?:operaci[oó]n|referencia)|\boperaci[oó]n\b|\bcomprobante\b)\s*(?:n[°º.o]*|nro\.?|#)?\s*[:.#-]?\s*(\d{4,20})/i;
  // Mensajes de pagos HECHOS por el comerciante, no recibidos.
  var RE_ENVIADO = /\b(enviaste|has enviado|pagaste|realizaste un pago|debitad[oa]|d[eé]bito)\b/i;

  /**
   * Lee un SMS o notificación del banco. Devuelve
   * { montoBs (centavos o null), referencia (texto de dígitos o null), banco (nombre o ''), enviado (bool) }.
   */
  function parsear(texto) {
    var t = String(texto || '').replace(/ /g, ' ');
    var r = { montoBs: null, referencia: null, banco: '', enviado: RE_ENVIADO.test(t) };

    for (var i = 0; i < RE_MONTOS.length; i++) {
      var m = t.match(RE_MONTOS[i]);
      if (m) {
        var c = montoACentavos(m[1]);
        if (isFinite(c) && c > 0) { r.montoBs = c; break; }
      }
    }
    var ref = t.match(RE_REFERENCIA);
    if (ref) r.referencia = ref[1];

    var bajo = t.toLowerCase();
    for (var j = 0; j < BANCOS.length; j++) {
      var nombre = BANCOS[j][1].toLowerCase();
      var corto = nombre.replace(/^banco (de |del )?/, '');
      if (bajo.indexOf(nombre) !== -1 || (corto.length > 3 && bajo.indexOf(corto) !== -1)) { r.banco = BANCOS[j][1]; break; }
    }
    if (!r.banco && /\bbdv\b|pagomovilbdv/i.test(t)) r.banco = 'Banco de Venezuela';
    return r;
  }

  /** Solo dígitos. */
  function limpiarRef(texto) { return String(texto || '').replace(/\D/g, ''); }

  /**
   * ¿La referencia que escribió el comerciante (p. ej. los últimos 6 dígitos) corresponde a la del banco?
   * Se exigen al menos 4 dígitos; los ceros a la izquierda de la del banco no importan.
   */
  function coincideRef(escrita, delBanco) {
    var a = limpiarRef(escrita), b = limpiarRef(delBanco);
    if (a.length < 4 || !b) return false;
    if (b.slice(-a.length) === a) return true;
    return b.replace(/^0+/, '') === a.replace(/^0+/, '');
  }

  window.CuadrePM = {
    BANCOS: BANCOS.map(function (b) { return b.slice(); }),
    nombreBanco: nombreBanco,
    montoACentavos: montoACentavos,
    parsear: parsear,
    limpiarRef: limpiarRef,
    coincideRef: coincideRef
  };
})();
