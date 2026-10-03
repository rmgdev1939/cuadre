/*
 * CUADRE · tasasauto.js
 * Busca las tasas del día en fuentes públicas y gratuitas, directo desde el navegador:
 *   - BCV dólar y BCV euro: DolarAPI (ve.dolarapi.com), que copia la tasa publicada por el BCV.
 *   - Binance (USDT/VES P2P): CriptoYa (criptoya.com); si falla, el paralelo de DolarAPI.
 * Son sugerencias: el comerciante puede corregirlas a mano. Si no hay conexión o una fuente
 * falla, no pasa nada: se queda la última tasa guardada y se sigue cobrando.
 *
 * Expone window.CuadreTasas.buscar() → Promise<{ bcv, eur, paralelo }>, cada una
 * { valor, fuente, fechaFuente } o null si esa fuente no respondió.
 */
(function () {
  'use strict';

  var ESPERA_MS = 8000;

  function pedir(url) {
    var control = typeof AbortController === 'function' ? new AbortController() : null;
    var reloj = setTimeout(function () { if (control) control.abort(); }, ESPERA_MS);
    return fetch(url, { cache: 'no-store', signal: control ? control.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) { clearTimeout(reloj); return json; }, function (e) { clearTimeout(reloj); throw e; });
  }

  function numero(x) {
    var n = Number(x);
    return isFinite(n) && n > 0 ? Math.round(n * 10000) / 10000 : null;
  }

  function fechaIso(x) {
    if (x == null) return null;
    var d = typeof x === 'number' ? new Date(x < 1e12 ? x * 1000 : x) : new Date(x);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** De la respuesta de DolarAPI ({ promedio, fechaActualizacion } o lista) saca la de `fuente`. */
  function deDolarApi(json, fuente, nombre) {
    var lista = Array.isArray(json) ? json : [json];
    var r = lista.filter(function (x) { return x && x.fuente === fuente; })[0];
    var valor = r && numero(r.promedio != null ? r.promedio : r.venta);
    return valor ? { valor: valor, fuente: nombre, fechaFuente: fechaIso(r.fechaActualizacion) } : null;
  }

  function bcvDolar() {
    return pedir('https://ve.dolarapi.com/v1/dolares').then(function (j) {
      return deDolarApi(j, 'oficial', 'DolarAPI');
    });
  }

  function bcvEuro() {
    return pedir('https://ve.dolarapi.com/v1/euros').then(function (j) {
      return deDolarApi(j, 'oficial', 'DolarAPI');
    });
  }

  /** Binance P2P: promedio entre el mejor precio de compra y de venta de USDT. */
  function binance() {
    return pedir('https://criptoya.com/api/binancep2p/USDT/VES/1').then(function (j) {
      var ask = numero(j && (j.totalAsk || j.ask)), bid = numero(j && (j.totalBid || j.bid));
      var valor = ask && bid ? numero((ask + bid) / 2) : (ask || bid);
      if (!valor) throw new Error('sin precio');
      return { valor: valor, fuente: 'CriptoYa', fechaFuente: fechaIso(j.time) || new Date().toISOString() };
    }).catch(function () {
      return pedir('https://ve.dolarapi.com/v1/dolares').then(function (j) {
        return deDolarApi(j, 'paralelo', 'DolarAPI (paralelo)');
      });
    });
  }

  function seguro(p) { return p.catch(function () { return null; }); }

  function buscar() {
    if (typeof fetch !== 'function') return Promise.resolve({ bcv: null, eur: null, paralelo: null });
    return Promise.all([seguro(bcvDolar()), seguro(bcvEuro()), seguro(binance())]).then(function (r) {
      return { bcv: r[0], eur: r[1], paralelo: r[2] };
    });
  }

  window.CuadreTasas = { buscar: buscar };
})();
