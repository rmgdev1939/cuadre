/*
 * CUADRE · db.js
 * Almacenamiento local con IndexedDB (offline-first).
 * Expone window.CuadreDB con métodos async.
 *
 * Base 'cuadre' v2
 *   - 'ventas' { id (autoIncrement), totalUsd, recibidoUsd, vueltoUsd, vueltoBs, tasa, fecha (ISO), dia ('YYYY-MM-DD' local),
 *                totalBs, efectivoUsd, restanteUsd, restanteBs, metodo ('efectivo' | 'mixto' | 'pago-movil'),
 *                tasaEur, tasaParalelo, cierreId, anuladaEn,
 *                canalBs ('pago-movil' | 'punto'), referencia, verificadaEn, verificacion ('sms' | 'manual'), refBanco,
 *                items: [{ productoId, nombre, precioUsd, cantidad }] }
 *       Los campos de la segunda línea llegaron con el pago mixto; las ventas anteriores no los tienen.
 *       tasaEur y tasaParalelo son solo referencia para el recibo (opcionales); los cálculos usan `tasa` (BCV USD).
 *       cierreId solo existe en ventas archivadas por un cierre de caja; sin él, la venta está "abierta".
 *       anuladaEn (ISO) marca una venta anulada: no se borra, pero no suma en los totales. Solo se anulan ventas abiertas.
 *       canalBs dice cómo se cobraron los Bs (metodo 'punto' = todo por punto de venta). Una venta con
 *       canalBs 'pago-movil' y restanteBs > 0 queda "por verificar" hasta tener verificadaEn (ISO).
 *       referencia = lo que escribió el comerciante (p. ej. últimos 6 dígitos); refBanco = la del SMS del banco.
 *       Las ventas anteriores a esto no tienen canalBs y no se piden verificar.
 *       índice 'dia'
 *   - 'config' { clave, ... }
 *       'tasa'          { clave, valor, fecha }  → tasa BCV USD (la única que usan los cálculos)
 *       'tasa-eur'      { clave, valor, fecha }  → tasa EUR (referencia)
 *       'tasa-paralelo' { clave, valor, fecha }  → tasa Paralelo/Binance (referencia)
 *       'comercio'      { clave, nombre, contacto, logo (data URL Base64 o null), tema,
 *                         pmBanco (código, p. ej. '0134'), pmTelefono, pmDocumento }  → datos de Pago Móvil del comercio
 *       'catalogo'      { clave, sigId, lista: [{ id, nombre, precioUsd, stock (número o null = sin control), activo, foto? }] }
 *                       → inventario. Vender con items descuenta stock en la misma transacción; anular lo devuelve.
 *                         Eliminar un producto solo lo marca activo:false (las ventas viejas conservan su nombre).
 *       'pagos-recibidos' { clave, lista: [{ referencia, montoBs, banco, recibido (ISO), texto, ventaId|null }] }
 *                       → pagos leídos de los SMS del banco; ventaId = venta que verificaron (cada pago verifica una sola).
 *       Las claves nuevas no requieren cambiar la versión de la base.
 *   - 'cierres' { id (autoIncrement), fecha (ISO), desde, hasta ('YYYY-MM-DD'), ventaIds, cantidad, anuladas, ...totales }  (v2)
 *       ventaIds incluye las ventas anuladas (también se archivan); cantidad y totales solo cuentan las válidas.
 *       Resumen de cada cierre de caja. Archivar nunca borra ventas.
 *
 * Respaldo: exportarRespaldo() → { app: 'cuadre', formato: 1, versionDb, exportado, ventas, cierres, config }.
 * importarRespaldo(datos) lo valida y reemplaza las tres tablas en una sola transacción.
 */
(function () {
  'use strict';

  var NOMBRE_DB = 'cuadre';
  var VERSION_DB = 2;
  var STORE_VENTAS = 'ventas';
  var STORE_CONFIG = 'config';
  var STORE_CIERRES = 'cierres';

  var conexion = null; // Promise<IDBDatabase>

  /** Fecha local en formato 'YYYY-MM-DD' (no UTC, para que el "día" sea el del comercio). */
  function diaLocal(fecha) {
    var d = fecha || new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  /** Convierte un IDBRequest en Promise. */
  function promesa(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /** Abre (o crea) la base de datos. Reutiliza la conexión si ya existe. */
  function abrir() {
    if (conexion) return conexion;
    if (!('indexedDB' in window)) {
      return Promise.reject(new Error('Este navegador no soporta IndexedDB'));
    }

    conexion = new Promise(function (resolve, reject) {
      var req = indexedDB.open(NOMBRE_DB, VERSION_DB);

      // v1 → v2 solo añade 'cierres': las ventas y la tasa existentes se conservan tal cual.
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_VENTAS)) {
          var ventas = db.createObjectStore(STORE_VENTAS, { keyPath: 'id', autoIncrement: true });
          ventas.createIndex('dia', 'dia', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_CONFIG)) {
          db.createObjectStore(STORE_CONFIG, { keyPath: 'clave' });
        }
        if (!db.objectStoreNames.contains(STORE_CIERRES)) {
          db.createObjectStore(STORE_CIERRES, { keyPath: 'id', autoIncrement: true });
        }
      };

      req.onsuccess = function () {
        var db = req.result;
        // Si otra pestaña actualiza la versión, cerramos para no bloquearla.
        db.onversionchange = function () {
          db.close();
          conexion = null;
        };
        resolve(db);
      };

      req.onerror = function () {
        conexion = null;
        reject(req.error);
      };

      req.onblocked = function () {
        console.warn('[CuadreDB] Apertura bloqueada: cierra otras pestañas de Cuadre.');
      };
    });

    return conexion;
  }

  /** Ejecuta una operación sobre un store y espera a que la transacción termine. */
  function conStore(nombre, modo, operacion) {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(nombre, modo);
        var resultado;
        tx.oncomplete = function () { resolve(resultado); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción abortada')); };
        promesa(operacion(tx.objectStore(nombre))).then(function (r) { resultado = r; }, function () {});
      });
    });
  }

  /** Tipo de tasa → clave en 'config'. 'bcv' conserva la clave original 'tasa'. */
  var CLAVES_TASA = { bcv: 'tasa', eur: 'tasa-eur', paralelo: 'tasa-paralelo' };

  function claveTasa(tipo) {
    var clave = CLAVES_TASA[tipo || 'bcv'];
    if (!clave) throw new Error('Tipo de tasa desconocido: ' + tipo);
    return clave;
  }

  /** Copia pública de un registro de tasa. */
  function tasaPublica(r) {
    if (!r) return null;
    var t = { valor: r.valor, fecha: r.fecha };
    if (r.fuente) { t.fuente = r.fuente; t.fechaFuente = r.fechaFuente || null; }
    return t;
  }

  /**
   * Guarda una tasa ('bcv' por defecto, 'eur' o 'paralelo' = Binance) con la hora del cambio.
   * `origen` opcional { fuente, fechaFuente } cuando la tasa llegó sola de internet; sin él, es manual.
   * Devuelve { valor, fecha, fuente?, fechaFuente? }.
   */
  function guardarTasa(valor, tipo, origen) {
    var numero = Number(valor);
    if (!isFinite(numero) || numero <= 0) {
      return Promise.reject(new Error('Tasa inválida'));
    }
    var registro = { clave: claveTasa(tipo), valor: numero, fecha: new Date().toISOString() };
    if (origen && origen.fuente) {
      registro.fuente = String(origen.fuente).slice(0, 40);
      registro.fechaFuente = origen.fechaFuente || null;
    }
    return conStore(STORE_CONFIG, 'readwrite', function (store) {
      return store.put(registro);
    }).then(function () {
      return tasaPublica(registro);
    });
  }

  /** Devuelve la última tasa guardada de ese tipo ('bcv' por defecto) { valor, fecha } o null. */
  function obtenerTasa(tipo) {
    var clave = claveTasa(tipo);
    return conStore(STORE_CONFIG, 'readonly', function (store) {
      return store.get(clave);
    }).then(function (r) {
      return tasaPublica(r);
    });
  }

  /** Las tres tasas: { bcv, eur, paralelo }, cada una { valor, fecha } o null. */
  function obtenerTasas() {
    return Promise.all([obtenerTasa('bcv'), obtenerTasa('eur'), obtenerTasa('paralelo')]).then(function (t) {
      return { bcv: t[0], eur: t[1], paralelo: t[2] };
    });
  }

  // ---------- Ajustes del comercio ----------
  var TEMAS = ['esmeralda', 'azul', 'naranja', 'oscuro', 'logo'];
  var AJUSTES_VACIOS = {
    nombre: '', contacto: '', logo: null, tema: null, pmBanco: '', pmTelefono: '', pmDocumento: '',
    colores: null,      // paleta sacada del logo { primario, primarioOscuro, primarioSuave, fondo, bs, bsSuave, tecla, teclaActiva }
    registrado: false,  // true tras el registro inicial
    pinHash: '', pinSal: '' // PIN para entrar: SHA-256 de sal + PIN (nunca el PIN en claro)
  };
  var CLAVES_COLORES = ['primario', 'primarioOscuro', 'primarioSuave', 'fondo', 'bs', 'bsSuave', 'tecla', 'teclaActiva'];

  function coloresValidos(c) {
    return c !== null && typeof c === 'object' && CLAVES_COLORES.every(function (k) { return /^#[0-9a-f]{6}$/i.test(c[k]); });
  }
  var CAMPOS_TEXTO = ['nombre', 'contacto', 'pmBanco', 'pmTelefono', 'pmDocumento'];

  function normalizarAjustes(r) {
    var a = Object.assign({}, AJUSTES_VACIOS, r || {});
    delete a.clave;
    if (TEMAS.indexOf(a.tema) === -1) a.tema = null; // null = aún no elegido
    if (!coloresValidos(a.colores)) a.colores = null;
    if (a.tema === 'logo' && !a.colores) a.tema = null;
    a.registrado = !!a.registrado;
    return a;
  }

  /** Ajustes del comercio { nombre, contacto, logo, tema }; valores vacíos si nunca se guardaron. */
  function obtenerAjustes() {
    return conStore(STORE_CONFIG, 'readonly', function (store) {
      return store.get('comercio');
    }).then(normalizarAjustes);
  }

  /**
   * Guarda solo los campos presentes en `cambios` (nombre, contacto, logo, tema) y conserva el resto,
   * leyendo y escribiendo en la misma transacción. Devuelve los ajustes completos.
   */
  function guardarAjustes(cambios) {
    var permitido = {};
    Object.keys(AJUSTES_VACIOS).forEach(function (k) {
      if (cambios && cambios[k] !== undefined) permitido[k] = cambios[k];
    });
    if (permitido.tema != null && TEMAS.indexOf(permitido.tema) === -1) {
      return Promise.reject(new Error('Tema desconocido: ' + permitido.tema));
    }
    if (permitido.colores != null && !coloresValidos(permitido.colores)) {
      return Promise.reject(new Error('Colores inválidos.'));
    }
    if (permitido.tema === 'logo' && permitido.colores === null) {
      return Promise.reject(new Error('El tema del logo necesita colores.'));
    }
    if (permitido.logo != null && !/^data:image\//.test(permitido.logo)) {
      return Promise.reject(new Error('El logo debe ser una imagen en Base64 (data URL).'));
    }
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_CONFIG, 'readwrite');
        var store = tx.objectStore(STORE_CONFIG);
        var registro;
        tx.oncomplete = function () { resolve(normalizarAjustes(registro)); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción abortada')); };
        store.get('comercio').onsuccess = function (e) {
          registro = Object.assign({}, AJUSTES_VACIOS, e.target.result || {}, permitido, {
            clave: 'comercio', fecha: new Date().toISOString()
          });
          CAMPOS_TEXTO.forEach(function (k) { registro[k] = String(registro[k] || '').trim(); });
          store.put(registro);
        };
      });
    });
  }

  /** Registra una venta. Usa venta.fecha (ISO) si viene, o la hora actual, y añade el día local. Devuelve el id generado. */
  function registrarVenta(venta) {
    var ahora = venta.fecha ? new Date(venta.fecha) : new Date();
    var registro = {
      totalUsd: Number(venta.totalUsd),
      recibidoUsd: Number(venta.recibidoUsd),
      vueltoUsd: Number(venta.vueltoUsd),
      vueltoBs: Number(venta.vueltoBs),
      tasa: Number(venta.tasa),
      fecha: ahora.toISOString(),
      dia: diaLocal(ahora)
    };
    // Campos del pago mixto (opcionales).
    ['totalBs', 'efectivoUsd', 'restanteUsd', 'restanteBs'].forEach(function (campo) {
      if (venta[campo] != null) registro[campo] = Number(venta[campo]);
    });
    if (venta.metodo) registro.metodo = String(venta.metodo);
    // Tasas de referencia vigentes al cobrar (para el recibo).
    ['tasaEur', 'tasaParalelo'].forEach(function (campo) {
      if (venta[campo] != null && Number(venta[campo]) > 0) registro[campo] = Number(venta[campo]);
    });
    // Pago Móvil / Punto de venta (opcionales).
    if (venta.canalBs === 'pago-movil' || venta.canalBs === 'punto') registro.canalBs = venta.canalBs;
    if (venta.referencia) registro.referencia = String(venta.referencia).replace(/\D/g, '').slice(0, 20);
    var items = normalizarItems(venta.items);
    if (!items.length) {
      return conStore(STORE_VENTAS, 'readwrite', function (store) {
        return store.add(registro);
      });
    }
    registro.items = items;
    // Con productos: la venta y el descuento de stock van juntos (o todo, o nada).
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_VENTAS, STORE_CONFIG], 'readwrite');
        var id;
        tx.oncomplete = function () { resolve(id); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción abortada')); };
        tx.objectStore(STORE_VENTAS).add(registro).onsuccess = function (e) { id = e.target.result; };
        moverStock(tx.objectStore(STORE_CONFIG), items, -1);
      });
    });
  }

  function normalizarItems(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(function (it) { return it && Number(it.cantidad) > 0; }).map(function (it) {
      return {
        productoId: Number(it.productoId), nombre: String(it.nombre || ''),
        precioUsd: Number(it.precioUsd) || 0, cantidad: Number(it.cantidad)
      };
    });
  }

  /** Suma (signo +1) o resta (−1) las cantidades de `items` al stock de los productos que lo controlan. */
  function moverStock(config, items, signo) {
    config.get(CLAVE_CATALOGO).onsuccess = function (e) {
      var cat = e.target.result;
      if (!cat || !Array.isArray(cat.lista)) return;
      var cambio = false;
      items.forEach(function (it) {
        var p = cat.lista.filter(function (x) { return x.id === it.productoId; })[0];
        if (p && p.stock != null) { p.stock = Math.round((p.stock + signo * it.cantidad) * 1000) / 1000; cambio = true; }
      });
      if (cambio) config.put(cat);
    };
  }

  // ---------- Inventario ----------
  var CLAVE_CATALOGO = 'catalogo';

  /** Productos activos, ordenados por nombre. */
  function obtenerCatalogo() {
    return conStore(STORE_CONFIG, 'readonly', function (store) {
      return store.get(CLAVE_CATALOGO);
    }).then(function (r) {
      return ((r && r.lista) || []).filter(function (p) { return p.activo !== false; })
        .sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    });
  }

  /** Lee y reescribe el catálogo en una transacción. `cambiar(cat)` devuelve el resultado a entregar. */
  function conCatalogo(cambiar) {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_CONFIG, 'readwrite');
        var store = tx.objectStore(STORE_CONFIG);
        var salida, error;
        tx.oncomplete = function () { resolve(salida); };
        tx.onerror = function () { reject(error || tx.error); };
        tx.onabort = function () { reject(error || tx.error || new Error('Transacción abortada')); };
        store.get(CLAVE_CATALOGO).onsuccess = function (e) {
          var cat = e.target.result || { clave: CLAVE_CATALOGO, sigId: 1, lista: [] };
          try { salida = cambiar(cat); } catch (err) { error = err; tx.abort(); return; }
          store.put(cat);
        };
      });
    });
  }

  /**
   * Crea o edita un producto { id?, nombre, precioUsd, stock (número o null), foto? }.
   * foto: data URL de imagen (JPEG pequeño), null para quitarla, ausente para no tocarla.
   * Devuelve el producto guardado.
   */
  function guardarProducto(datos) {
    var nombre = String(datos && datos.nombre || '').trim().slice(0, 60);
    var precio = Math.round(Number(datos && datos.precioUsd) * 100) / 100;
    var stock = datos && datos.stock != null && datos.stock !== '' ? Number(datos.stock) : null;
    if (!nombre) return Promise.reject(new Error('Escribe el nombre del producto.'));
    if (!isFinite(precio) || precio <= 0) return Promise.reject(new Error('Escribe un precio mayor que cero.'));
    if (stock != null && !isFinite(stock)) return Promise.reject(new Error('El stock debe ser un número.'));
    var foto = datos ? datos.foto : undefined;
    if (foto != null && !/^data:image\/(jpeg|png|webp);base64,/.test(String(foto))) return Promise.reject(new Error('La foto no es válida.'));
    if (foto && foto.length > 200000) return Promise.reject(new Error('La foto es demasiado grande.'));
    return conCatalogo(function (cat) {
      var p = datos.id != null ? cat.lista.filter(function (x) { return x.id === Number(datos.id); })[0] : null;
      if (datos.id != null && !p) throw new Error('El producto ya no existe.');
      if (!p) { p = { id: cat.sigId++, activo: true }; cat.lista.push(p); }
      p.nombre = nombre;
      p.precioUsd = precio;
      p.stock = stock;
      if (foto !== undefined) { if (foto) p.foto = foto; else delete p.foto; }
      return Object.assign({}, p);
    });
  }

  /** Quita un producto del inventario (queda inactivo; las ventas que lo usaron no cambian). */
  function eliminarProducto(id) {
    return conCatalogo(function (cat) {
      var p = cat.lista.filter(function (x) { return x.id === Number(id); })[0];
      if (p) p.activo = false;
      return true;
    });
  }

  // ---------- Pagos recibidos (SMS del banco) ----------
  var CLAVE_PAGOS = 'pagos-recibidos';
  var MAX_PAGOS = 500;

  /** Pagos leídos de SMS, del más reciente al más antiguo. */
  function pagosRecibidos() {
    return conStore(STORE_CONFIG, 'readonly', function (store) {
      return store.get(CLAVE_PAGOS);
    }).then(function (r) {
      return (r && Array.isArray(r.lista) ? r.lista : []).slice();
    });
  }

  /**
   * Guarda un pago leído de un SMS { referencia, montoBs (decimal), banco, texto }.
   * La misma referencia no se guarda dos veces: devuelve { pago, nuevo } con el que ya estaba.
   */
  function guardarPagoRecibido(datos) {
    var referencia = String(datos && datos.referencia || '').replace(/\D/g, '');
    var monto = Number(datos && datos.montoBs);
    if (!referencia || !isFinite(monto) || monto <= 0) return Promise.reject(new Error('El pago necesita referencia y monto.'));
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_CONFIG, 'readwrite');
        var store = tx.objectStore(STORE_CONFIG);
        var salida;
        tx.oncomplete = function () { resolve(salida); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción abortada')); };
        store.get(CLAVE_PAGOS).onsuccess = function (e) {
          var lista = (e.target.result && e.target.result.lista) || [];
          var previo = lista.filter(function (p) { return p.referencia === referencia; })[0];
          if (previo) { salida = { pago: previo, nuevo: false }; return; }
          var pago = {
            referencia: referencia, montoBs: monto, banco: String(datos.banco || ''),
            recibido: new Date().toISOString(), texto: String(datos.texto || '').slice(0, 400), ventaId: null
          };
          lista.unshift(pago);
          store.put({ clave: CLAVE_PAGOS, lista: lista.slice(0, MAX_PAGOS) });
          salida = { pago: pago, nuevo: true };
        };
      });
    });
  }

  /** Guarda en la venta el correo al que se envió su factura. Devuelve la venta. */
  function anotarCorreo(id, correo) {
    var texto = String(correo || '').trim().slice(0, 120);
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_VENTAS, 'readwrite');
        var store = tx.objectStore(STORE_VENTAS);
        var venta;
        tx.oncomplete = function () { resolve(venta); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('No se pudo guardar el correo')); };
        store.get(Number(id)).onsuccess = function (e) {
          venta = e.target.result;
          if (!venta) return;
          if (texto) venta.correo = texto; else delete venta.correo;
          store.put(venta);
        };
      });
    });
  }

  /**
   * Marca una venta abierta como verificada, en una sola transacción.
   * opciones.referencia = referencia del pago (SMS) que la verifica; ese pago queda ligado a la venta
   * y no puede verificar otra. Sin referencia, opciones.via = 'manual' (el comerciante lo vio en su banco).
   * Devuelve la venta actualizada.
   */
  function verificarVenta(id, opciones) {
    var o = opciones || {};
    var refPago = o.referencia ? String(o.referencia) : null;
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_VENTAS, STORE_CONFIG], 'readwrite');
        var ventas = tx.objectStore(STORE_VENTAS);
        var config = tx.objectStore(STORE_CONFIG);
        var venta, error;
        function fallar(texto) { error = new Error(texto); tx.abort(); }
        tx.oncomplete = function () { resolve(venta); };
        tx.onerror = function () { reject(error || tx.error); };
        tx.onabort = function () { reject(error || tx.error || new Error('Transacción abortada')); };
        ventas.get(Number(id)).onsuccess = function (e) {
          venta = e.target.result;
          if (!venta) return fallar('La venta no existe.');
          if (venta.anuladaEn) return fallar('La venta está anulada.');
          if (venta.cierreId != null) return fallar('La venta ya está en un cierre de caja.');
          if (venta.verificadaEn) return;
          if (!refPago) {
            venta.verificadaEn = new Date().toISOString();
            venta.verificacion = 'manual';
            ventas.put(venta);
            return;
          }
          config.get(CLAVE_PAGOS).onsuccess = function (ev) {
            var registro = ev.target.result;
            var lista = (registro && registro.lista) || [];
            var pago = lista.filter(function (p) { return p.referencia === refPago; })[0];
            if (!pago) return fallar('No encontré ese pago.');
            if (pago.ventaId != null && pago.ventaId !== venta.id) return fallar('Ese pago ya verificó otra venta.');
            pago.ventaId = venta.id;
            config.put(registro);
            venta.verificadaEn = new Date().toISOString();
            venta.verificacion = 'sms';
            venta.refBanco = pago.referencia;
            ventas.put(venta);
          };
        };
      });
    });
  }

  /** Ventas de un día ('YYYY-MM-DD'); por defecto, hoy. Ordenadas por id. */
  function ventasDelDia(dia) {
    var clave = dia || diaLocal();
    return conStore(STORE_VENTAS, 'readonly', function (store) {
      return store.index('dia').getAll(IDBKeyRange.only(clave));
    }).then(function (lista) {
      return (lista || []).sort(function (a, b) { return a.id - b.id; });
    });
  }

  /** Ventas (abiertas y archivadas) entre dos días 'YYYY-MM-DD' inclusive, ordenadas por id. */
  function ventasEntre(desde, hasta) {
    return conStore(STORE_VENTAS, 'readonly', function (store) {
      return store.index('dia').getAll(IDBKeyRange.bound(desde, hasta));
    }).then(function (lista) {
      return (lista || []).sort(function (a, b) { return a.id - b.id; });
    });
  }

  /** Ventas aún no archivadas por un cierre (de cualquier día), ordenadas por id. */
  function ventasAbiertas() {
    return conStore(STORE_VENTAS, 'readonly', function (store) {
      return store.getAll();
    }).then(function (lista) {
      return (lista || []).filter(function (v) { return v.cierreId == null; })
        .sort(function (a, b) { return a.id - b.id; });
    });
  }

  /**
   * Cierre de caja: guarda `resumen` en 'cierres' y marca las ventas `ventaIds` con su cierreId,
   * todo en una sola transacción (o se archiva todo, o nada). Devuelve el cierre guardado con su id.
   */
  function archivarVentas(ventaIds, resumen) {
    var ids = (ventaIds || []).slice();
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_VENTAS, STORE_CIERRES], 'readwrite');
        var cierre = Object.assign({}, resumen, { fecha: new Date().toISOString(), ventaIds: ids });
        tx.oncomplete = function () { resolve(cierre); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción abortada')); };

        var ventas = tx.objectStore(STORE_VENTAS);
        tx.objectStore(STORE_CIERRES).add(cierre).onsuccess = function (e) {
          cierre.id = e.target.result;
          ids.forEach(function (id) {
            ventas.get(id).onsuccess = function (ev) {
              var venta = ev.target.result;
              if (!venta || venta.cierreId != null) return;
              venta.cierreId = cierre.id;
              ventas.put(venta);
            };
          });
        };
      });
    });
  }

  /** Cierres guardados, del más reciente al más antiguo. */
  function cierres() {
    return conStore(STORE_CIERRES, 'readonly', function (store) {
      return store.getAll();
    }).then(function (lista) {
      return (lista || []).sort(function (a, b) { return b.id - a.id; });
    });
  }

  /**
   * Anula una venta abierta: le pone anuladaEn (ISO) sin borrarla. Las ventas ya archivadas por un
   * cierre no se pueden anular. Devuelve la venta actualizada (si ya estaba anulada, tal cual).
   */
  function anularVenta(id) {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_VENTAS, STORE_CONFIG], 'readwrite');
        var store = tx.objectStore(STORE_VENTAS);
        var venta, error;
        tx.oncomplete = function () { if (error) reject(error); else resolve(venta); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(error || tx.error || new Error('Transacción abortada')); };
        store.get(Number(id)).onsuccess = function (e) {
          venta = e.target.result;
          if (!venta) { error = new Error('La venta no existe.'); return; }
          if (venta.cierreId != null) { error = new Error('La venta ya está en un cierre de caja.'); return; }
          if (venta.anuladaEn) return;
          venta.anuladaEn = new Date().toISOString();
          store.put(venta);
          if (venta.items && venta.items.length) moverStock(tx.objectStore(STORE_CONFIG), venta.items, +1);
        };
      });
    });
  }

  // ---------- Respaldo ----------
  var FORMATO_RESPALDO = 1;
  var STORES = [STORE_VENTAS, STORE_CIERRES, STORE_CONFIG];

  /** Todo el contenido de la base en un objeto listo para JSON (lectura en una sola transacción). */
  function exportarRespaldo() {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORES, 'readonly');
        var datos = {
          app: 'cuadre', formato: FORMATO_RESPALDO, versionDb: VERSION_DB,
          exportado: new Date().toISOString(), ventas: [], cierres: [], config: []
        };
        tx.oncomplete = function () { resolve(datos); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción abortada')); };
        tx.objectStore(STORE_VENTAS).getAll().onsuccess = function (e) { datos.ventas = e.target.result || []; };
        tx.objectStore(STORE_CIERRES).getAll().onsuccess = function (e) { datos.cierres = e.target.result || []; };
        tx.objectStore(STORE_CONFIG).getAll().onsuccess = function (e) { datos.config = e.target.result || []; };
      });
    });
  }

  function esObjeto(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function esId(x) { return typeof x === 'number' && Number.isInteger(x) && x > 0; }
  function esNumero(x) { return typeof x === 'number' && isFinite(x); }
  function esFecha(x) { return typeof x === 'string' && !isNaN(Date.parse(x)); }
  function esDia(x) { return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x); }

  function fallo(texto) { throw new Error('El archivo no es un respaldo válido: ' + texto + '.'); }

  /** Revisa que cada registro sea un objeto con id entero y único. Devuelve { id: true }. */
  function revisarIds(lista, nombre) {
    var vistos = {};
    lista.forEach(function (r, i) {
      if (!esObjeto(r)) fallo(nombre + ' n.º ' + (i + 1) + ' no es un registro');
      if (!esId(r.id)) fallo(nombre + ' n.º ' + (i + 1) + ' no tiene un id válido');
      if (vistos[r.id]) fallo('hay dos ' + nombre + 's con el id ' + r.id);
      vistos[r.id] = true;
    });
    return vistos;
  }

  /**
   * Valida un respaldo sin tocar la base. Lanza Error con un mensaje para el usuario si algo no cuadra;
   * si todo está bien devuelve { ventas, cierres, anuladas, exportado } para la confirmación.
   */
  function validarRespaldo(datos) {
    if (!esObjeto(datos) || datos.app !== 'cuadre') fallo('no es un archivo de Cuadre');
    if (!esId(datos.formato)) fallo('falta el formato');
    if (datos.formato > FORMATO_RESPALDO) fallo('viene de una versión más nueva de Cuadre; actualiza la app');
    ['ventas', 'cierres', 'config'].forEach(function (k) {
      if (!Array.isArray(datos[k])) fallo('falta la lista de ' + k);
    });

    revisarIds(datos.ventas, 'venta');
    var cierresIds = revisarIds(datos.cierres, 'cierre');
    var anuladas = 0;
    datos.ventas.forEach(function (v) {
      var donde = 'la venta ' + v.id;
      if (!esNumero(v.totalUsd) || v.totalUsd < 0) fallo(donde + ' no tiene un total válido');
      if (!esNumero(v.tasa) || v.tasa <= 0) fallo(donde + ' no tiene una tasa válida');
      if (!esFecha(v.fecha)) fallo(donde + ' no tiene una fecha válida');
      if (!esDia(v.dia)) fallo(donde + ' no tiene un día válido');
      if (v.cierreId != null && !cierresIds[v.cierreId]) fallo(donde + ' apunta a un cierre que no está');
      if (v.anuladaEn != null) {
        if (!esFecha(v.anuladaEn)) fallo(donde + ' tiene una fecha de anulación inválida');
        anuladas++;
      }
    });
    datos.cierres.forEach(function (c) {
      var donde = 'el cierre ' + c.id;
      if (!esFecha(c.fecha)) fallo(donde + ' no tiene una fecha válida');
      if (!Array.isArray(c.ventaIds) || !c.ventaIds.every(esId)) fallo(donde + ' no tiene su lista de ventas');
      if (!esNumero(c.totalUsd)) fallo(donde + ' no tiene un total válido');
    });

    var claves = {};
    datos.config.forEach(function (r, i) {
      if (!esObjeto(r) || typeof r.clave !== 'string' || !r.clave) fallo('el ajuste n.º ' + (i + 1) + ' no tiene clave');
      if (claves[r.clave]) fallo('el ajuste «' + r.clave + '» está repetido');
      claves[r.clave] = true;
      var esTasa = Object.keys(CLAVES_TASA).some(function (t) { return CLAVES_TASA[t] === r.clave; });
      if (esTasa && (!esNumero(r.valor) || r.valor <= 0 || !esFecha(r.fecha))) fallo('la tasa «' + r.clave + '» no es válida');
      if (r.clave === 'comercio') {
        if (r.logo != null && !(typeof r.logo === 'string' && /^data:image\//.test(r.logo))) fallo('el logo no es una imagen');
        if (r.tema != null && TEMAS.indexOf(r.tema) === -1) fallo('el tema no existe');
      }
    });

    return {
      ventas: datos.ventas.length, cierres: datos.cierres.length, anuladas: anuladas,
      exportado: esFecha(datos.exportado) ? datos.exportado : null
    };
  }

  /**
   * Reemplaza TODOS los datos locales por los del respaldo, en una sola transacción:
   * si algo falla, la base queda como estaba. Valida antes de abrir la transacción.
   */
  function importarRespaldo(datos) {
    var resumen;
    try { resumen = validarRespaldo(datos); } catch (e) { return Promise.reject(e); }
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORES, 'readwrite');
        tx.oncomplete = function () { resolve(resumen); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción abortada')); };
        [[STORE_VENTAS, datos.ventas], [STORE_CIERRES, datos.cierres], [STORE_CONFIG, datos.config]].forEach(function (p) {
          var store = tx.objectStore(p[0]);
          store.clear();
          p[1].forEach(function (r) { store.put(r); });
        });
      });
    });
  }

  window.CuadreDB = {
    abrir: abrir,
    guardarTasa: guardarTasa,
    obtenerTasa: obtenerTasa,
    obtenerTasas: obtenerTasas,
    obtenerAjustes: obtenerAjustes,
    guardarAjustes: guardarAjustes,
    TEMAS: TEMAS.slice(),
    registrarVenta: registrarVenta,
    ventasDelDia: ventasDelDia,
    ventasAbiertas: ventasAbiertas,
    ventasEntre: ventasEntre,
    archivarVentas: archivarVentas,
    cierres: cierres,
    anularVenta: anularVenta,
    pagosRecibidos: pagosRecibidos,
    guardarPagoRecibido: guardarPagoRecibido,
    verificarVenta: verificarVenta,
    obtenerCatalogo: obtenerCatalogo,
    guardarProducto: guardarProducto,
    anotarCorreo: anotarCorreo,
    eliminarProducto: eliminarProducto,
    exportarRespaldo: exportarRespaldo,
    validarRespaldo: validarRespaldo,
    importarRespaldo: importarRespaldo,
    diaLocal: diaLocal
  };
})();
