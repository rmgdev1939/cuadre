/*
 * CUADRE · escucha.js
 * Verificación automática de Pago Móvil (prototipo).
 * La app de Android "Cuadre Escucha", en el teléfono donde llegan los avisos del banco,
 * publica cada aviso en un canal de la nube; este teléfono de caja los lee y Cuadre los
 * empareja con la venta como si el comerciante hubiera compartido el SMS.
 *
 * El canal es un secreto aleatorio (128 bits) que viaja dentro del "código de vinculación"
 * junto con la dirección de la nube. Se guarda solo en este teléfono (localStorage).
 * La nube no lee nada: solo guarda el texto del aviso 3 días (ver nube/escucha.sql).
 *
 * Expone window.CuadreEscucha. Sin DOM ni IndexedDB.
 */
(function () {
  'use strict';

  // Nube de Cuadre (Supabase). Vacío hasta crear el proyecto; mientras tanto se puede
  // apuntar a una nube de prueba con localStorage 'cuadre-nube' = '{"url":"…","clave":"…"}'.
  var NUBE = { url: '', clave: '' };

  var CLAVE = 'cuadre-escucha';
  var PREFIJO = 'CUADRE1.';
  var TIEMPO = 8000;

  function leerLS(clave) {
    try { return JSON.parse(localStorage.getItem(clave) || 'null'); } catch (e) { return null; }
  }
  function guardarLS(clave, valor) {
    try {
      if (valor == null) localStorage.removeItem(clave); else localStorage.setItem(clave, JSON.stringify(valor));
      return true;
    } catch (e) { return false; }
  }

  function nube() {
    var prueba = leerLS('cuadre-nube');
    if (prueba && prueba.url && prueba.clave) return prueba;
    return NUBE.url && NUBE.clave ? NUBE : null;
  }

  function config() {
    var c = leerLS(CLAVE);
    return c && c.url && c.clave && c.canal ? c : null;
  }

  function base64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function aBase64url(texto) {
    return base64url(new TextEncoder().encode(texto));
  }
  function deBase64url(texto) {
    var b = texto.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function nuevoCanal() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  /** Código que se comparte con el teléfono del dueño y con otras cajas del comercio. */
  function codigo() {
    var c = config();
    if (!c) return '';
    return PREFIJO + aBase64url(JSON.stringify({ u: c.url, k: c.clave, c: c.canal }));
  }

  /** Lee un código (aunque venga dentro de un mensaje de WhatsApp). null si no es válido. */
  function leerCodigo(texto) {
    var m = String(texto || '').match(/CUADRE1\.([A-Za-z0-9_-]{20,})/);
    if (!m) return null;
    try {
      var d = JSON.parse(deBase64url(m[1]));
      if (!d || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(d.u) || !d.k || !/^[A-Za-z0-9_-]{20,80}$/.test(d.c)) return null;
      return { url: String(d.u).replace(/\/+$/, ''), clave: String(d.k), canal: d.c };
    } catch (e) {
      return null;
    }
  }

  /** Crea un canal nuevo en la nube de Cuadre. Devuelve el código. */
  function activar() {
    var n = nube();
    if (!n) return Promise.reject(new Error('La nube de Cuadre todavía no está configurada.'));
    if (!guardarLS(CLAVE, { url: n.url.replace(/\/+$/, ''), clave: n.clave, canal: nuevoCanal(), desde: 0 })) {
      return Promise.reject(new Error('Este navegador no deja guardar datos.'));
    }
    return Promise.resolve(codigo());
  }

  /** Une este teléfono a un canal existente (otra caja del mismo comercio). */
  function unir(texto) {
    var d = leerCodigo(texto);
    if (!d) return Promise.reject(new Error('Ese código no es válido. Cópialo completo, empieza por CUADRE1.'));
    d.desde = 0;
    if (!guardarLS(CLAVE, d)) return Promise.reject(new Error('Este navegador no deja guardar datos.'));
    return Promise.resolve(codigo());
  }

  function desactivar() { guardarLS(CLAVE, null); }

  function rpc(c, funcion, cuerpo) {
    var control = typeof AbortController === 'function' ? new AbortController() : null;
    var reloj = control ? setTimeout(function () { control.abort(); }, TIEMPO) : null;
    return fetch(c.url + '/rest/v1/rpc/' + funcion, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: c.clave, Authorization: 'Bearer ' + c.clave },
      body: JSON.stringify(cuerpo),
      signal: control ? control.signal : undefined,
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('La nube respondió ' + r.status);
      return r.json();
    }).finally(function () { if (reloj) clearTimeout(reloj); });
  }

  /**
   * Trae los avisos nuevos del canal: [{ id, texto, origen, recibido }].
   * Avanza el cursor solo después de leerlos, así un fallo no pierde avisos.
   */
  function leer() {
    var c = config();
    if (!c) return Promise.resolve([]);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve([]);
    return rpc(c, 'escucha_leer', { p_canal: c.canal, p_desde: c.desde || 0 }).then(function (lista) {
      lista = Array.isArray(lista) ? lista : [];
      if (lista.length) {
        var actual = config();
        if (actual && actual.canal === c.canal) {
          actual.desde = Math.max(actual.desde || 0, lista[lista.length - 1].id);
          guardarLS(CLAVE, actual);
        }
      }
      return lista;
    });
  }

  /** Publica un aviso en el canal (lo usa la app Escucha; aquí sirve para pruebas). */
  function publicar(texto, origen) {
    var c = config();
    if (!c) return Promise.reject(new Error('Sin canal.'));
    return rpc(c, 'escucha_publicar', { p_canal: c.canal, p_texto: String(texto), p_origen: origen || 'prueba' });
  }

  window.CuadreEscucha = {
    activo: function () { return !!config(); },
    hayNube: function () { return !!nube(); },
    codigo: codigo,
    leerCodigo: leerCodigo,
    activar: activar,
    unir: unir,
    desactivar: desactivar,
    leer: leer,
    publicar: publicar
  };
})();
