/*
 * CUADRE · factura.js
 * Arma la nota de venta del cliente como PDF, en el propio teléfono y sin internet.
 * No usa librerías: escribe el PDF a mano (fuentes Helvetica integradas al lector y el logo como JPEG).
 *
 * window.CuadreFactura.crear(datos) → Promise<Blob> (application/pdf), con datos:
 * {
 *   numero, fecha (texto), cliente (texto, opcional),
 *   comercio: { nombre, contacto, logo (data URL), color (#hex), colorSuave (#hex) },
 *   items: [{ nombre, cantidad (texto), precio (texto), importe (texto) }],
 *   totales: [[etiqueta, valor, destacado?]], pagos: [[etiqueta, valor]], pie (texto)
 * }
 */
(function () {
  'use strict';

  var ANCHO = 420, ALTO = 595; // A5 vertical, en puntos
  var MARGEN = 28;

  // Anchos de Helvetica y Helvetica-Bold (1/1000 em) para los caracteres 32..126.
  var W_NORMAL = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  var W_NEGRITA = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  var ESPECIALES = { '€': 128, '•': 149, '–': 150, '—': 151, '‘': 145, '’': 146, '“': 147, '”': 148, '…': 133 };

  /** Texto → bytes WinAnsi (como cadena de caracteres 0..255). Lo que no existe se vuelve '?'. */
  function winAnsi(texto) {
    var s = String(texto == null ? '' : texto), out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), c = s.charCodeAt(i);
      if (ESPECIALES[ch]) out += String.fromCharCode(ESPECIALES[ch]);
      else if ((c >= 32 && c < 127) || (c >= 160 && c <= 255)) out += ch;
      else out += '?';
    }
    return out;
  }

  function escapar(bytes) { return bytes.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

  function anchoTexto(texto, tam, negrita) {
    var tabla = negrita ? W_NEGRITA : W_NORMAL;
    var s = String(texto == null ? '' : texto);
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    var total = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      total += c >= 32 && c <= 126 ? tabla[c - 32] : 556;
    }
    return total * tam / 1000;
  }

  /** Recorta con "..." para que quepa en `max` puntos. */
  function ajustar(texto, max, tam, negrita) {
    var s = String(texto || '');
    if (anchoTexto(s, tam, negrita) <= max) return s;
    while (s.length > 1 && anchoTexto(s + '...', tam, negrita) > max) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '...';
  }

  function rgb(hex) {
    var h = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    var n = h ? parseInt(h[1], 16) : 0x047857;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) { return (v / 255).toFixed(3); }).join(' ');
  }

  function num(n) { return (Math.round(n * 100) / 100).toString(); }

  /** Lienzo de una página: acumula operadores PDF con coordenadas medidas desde arriba. */
  function Pagina() { this.ops = []; }
  Pagina.prototype.rect = function (x, y, w, h, color) {
    this.ops.push(rgb(color) + ' rg ' + num(x) + ' ' + num(ALTO - y - h) + ' ' + num(w) + ' ' + num(h) + ' re f');
  };
  Pagina.prototype.linea = function (x1, y, x2, color, grosor) {
    this.ops.push(rgb(color) + ' RG ' + num(grosor || 0.6) + ' w ' + num(x1) + ' ' + num(ALTO - y) + ' m ' + num(x2) + ' ' + num(ALTO - y) + ' l S');
  };
  /** alin: 'izq' | 'der' | 'centro'; y es la línea base medida desde arriba. */
  Pagina.prototype.texto = function (t, x, y, tam, opciones) {
    var o = opciones || {};
    var ancho = anchoTexto(t, tam, o.negrita);
    if (o.alin === 'der') x -= ancho;
    else if (o.alin === 'centro') x -= ancho / 2;
    this.ops.push('BT /' + (o.negrita ? 'F2' : 'F1') + ' ' + num(tam) + ' Tf ' + rgb(o.color || '#1f2937') + ' rg ' +
      num(x) + ' ' + num(ALTO - y) + ' Td (' + escapar(winAnsi(t)) + ') Tj ET');
  };
  Pagina.prototype.imagen = function (x, y, w, h) {
    this.ops.push('q ' + num(w) + ' 0 0 ' + num(h) + ' ' + num(x) + ' ' + num(ALTO - y - h) + ' cm /Im1 Do Q');
  };

  /** Logo (data URL) → { bytes JPEG, ancho, alto } sobre fondo blanco, o null. */
  function logoJpeg(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var escala = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * escala)), h = Math.max(1, Math.round(img.naturalHeight * escala));
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          var b64 = c.toDataURL('image/jpeg', 0.9).split(',')[1];
          resolve({ bytes: atob(b64), ancho: w, alto: h });
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  /** Une las páginas y el logo en un archivo PDF. */
  function armarPdf(paginas, logo) {
    var objetos = []; // texto de cada objeto (bytes), índice + 1 = número de objeto
    function agregar(contenido) { objetos.push(contenido); return objetos.length; }

    var catalogo = agregar(null);
    var raiz = agregar(null);
    var f1 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    var f2 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    var im = logo ? agregar('<< /Type /XObject /Subtype /Image /Width ' + logo.ancho + ' /Height ' + logo.alto +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + logo.bytes.length + ' >>\nstream\n' +
      logo.bytes + '\nendstream') : 0;
    var recursos = '<< /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >>' + (im ? ' /XObject << /Im1 ' + im + ' 0 R >>' : '') + ' >>';

    var hijos = paginas.map(function (p) {
      var flujo = p.ops.join('\n');
      var contenido = agregar('<< /Length ' + flujo.length + ' >>\nstream\n' + flujo + '\nendstream');
      return agregar('<< /Type /Page /Parent ' + raiz + ' 0 R /MediaBox [0 0 ' + ANCHO + ' ' + ALTO + '] /Resources ' + recursos +
        ' /Contents ' + contenido + ' 0 R >>');
    });
    objetos[catalogo - 1] = '<< /Type /Catalog /Pages ' + raiz + ' 0 R >>';
    objetos[raiz - 1] = '<< /Type /Pages /Kids [' + hijos.map(function (h) { return h + ' 0 R'; }).join(' ') + '] /Count ' + hijos.length + ' >>';

    var salida = '%PDF-1.4\n%âãÏÓ\n';
    var posiciones = [];
    objetos.forEach(function (o, i) {
      posiciones.push(salida.length);
      salida += (i + 1) + ' 0 obj\n' + o + '\nendobj\n';
    });
    var xref = salida.length;
    salida += 'xref\n0 ' + (objetos.length + 1) + '\n0000000000 65535 f \n';
    posiciones.forEach(function (p) { salida += ('0000000000' + p).slice(-10) + ' 00000 n \n'; });
    salida += 'trailer\n<< /Size ' + (objetos.length + 1) + ' /Root ' + catalogo + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';

    var bytes = new Uint8Array(salida.length);
    for (var i = 0; i < salida.length; i++) bytes[i] = salida.charCodeAt(i) & 255;
    return new Blob([bytes], { type: 'application/pdf' });
  }

  function crear(d) {
    var c = d.comercio || {};
    var color = c.color || '#047857', suave = c.colorSuave || '#ecfdf5';
    var gris = '#6b7280', tinta = '#1f2937', borde = '#e5e7eb';

    return logoJpeg(c.logo).then(function (logo) {
      var paginas = [];
      var p, y;

      function cabecera() {
        p = new Pagina();
        paginas.push(p);
        p.rect(0, 0, ANCHO, 92, color);
        var x = MARGEN;
        if (logo) {
          var lado = 56, escala = lado / Math.max(logo.ancho, logo.alto);
          var w = logo.ancho * escala, h = logo.alto * escala;
          p.rect(MARGEN - 4, 18 - 4, lado + 8, lado + 8, '#ffffff');
          p.imagen(MARGEN + (lado - w) / 2, 18 + (lado - h) / 2, w, h);
          x = MARGEN + lado + 14;
        }
        var anchoNombre = ANCHO - MARGEN - x - 120;
        p.texto(ajustar(c.nombre || 'Mi negocio', anchoNombre, 15, true), x, 42, 15, { negrita: true, color: '#ffffff' });
        if (c.contacto) p.texto(ajustar(c.contacto, anchoNombre, 9), x, 58, 9, { color: '#ffffff' });
        p.texto('NOTA DE VENTA', ANCHO - MARGEN, 36, 10, { negrita: true, color: '#ffffff', alin: 'der' });
        p.texto('N.º ' + d.numero, ANCHO - MARGEN, 52, 12, { negrita: true, color: '#ffffff', alin: 'der' });
        p.texto(d.fecha, ANCHO - MARGEN, 67, 8.5, { color: '#ffffff', alin: 'der' });
        y = 116;
      }

      function filaTitulos() {
        p.rect(MARGEN, y - 12, ANCHO - 2 * MARGEN, 18, suave);
        p.texto('Descripción', MARGEN + 6, y, 8.5, { negrita: true, color: tinta });
        p.texto('Cant.', 250, y, 8.5, { negrita: true, color: tinta, alin: 'der' });
        p.texto('Precio', 316, y, 8.5, { negrita: true, color: tinta, alin: 'der' });
        p.texto('Importe', ANCHO - MARGEN - 6, y, 8.5, { negrita: true, color: tinta, alin: 'der' });
        y += 20;
      }

      function hayEspacio(alto) {
        if (y + alto <= ALTO - 60) return;
        cabecera();
        filaTitulos();
      }

      cabecera();
      if (d.cliente) {
        p.texto('Cliente', MARGEN, y, 8, { color: gris });
        p.texto(ajustar(d.cliente, ANCHO - 2 * MARGEN - 50, 10), MARGEN + 40, y, 10, { color: tinta });
        y += 22;
      }

      filaTitulos();
      (d.items || []).forEach(function (it) {
        hayEspacio(18);
        p.texto(ajustar(it.nombre, 190, 9.5), MARGEN + 6, y, 9.5, { color: tinta });
        p.texto(it.cantidad, 250, y, 9.5, { color: tinta, alin: 'der' });
        p.texto(it.precio, 316, y, 9.5, { color: tinta, alin: 'der' });
        p.texto(it.importe, ANCHO - MARGEN - 6, y, 9.5, { color: tinta, alin: 'der' });
        p.linea(MARGEN, y + 6, ANCHO - MARGEN, borde);
        y += 18;
      });

      y += 8;
      (d.totales || []).forEach(function (t) {
        hayEspacio(t[2] ? 26 : 16);
        if (t[2]) {
          p.rect(ANCHO / 2 - 10, y - 13, ANCHO / 2 - MARGEN + 10, 22, color);
          p.texto(t[0], ANCHO / 2 - 2, y + 2, 10, { negrita: true, color: '#ffffff' });
          p.texto(t[1], ANCHO - MARGEN - 6, y + 2, 12, { negrita: true, color: '#ffffff', alin: 'der' });
          y += 28;
        } else {
          p.texto(t[0], ANCHO / 2 - 2, y, 9, { color: gris });
          p.texto(t[1], ANCHO - MARGEN - 6, y, 9.5, { color: tinta, alin: 'der' });
          y += 16;
        }
      });

      if (d.pagos && d.pagos.length) {
        hayEspacio(30);
        y += 6;
        p.texto('Forma de pago', MARGEN, y, 9, { negrita: true, color: tinta });
        y += 16;
        d.pagos.forEach(function (l) {
          hayEspacio(16);
          p.texto(l[0], MARGEN, y, 9, { color: gris });
          p.texto(ajustar(l[1], 180, 9.5), ANCHO - MARGEN - 6, y, 9.5, { color: tinta, alin: 'der' });
          y += 15;
        });
      }

      paginas.forEach(function (pg, i) {
        pg.linea(MARGEN, ALTO - 44, ANCHO - MARGEN, borde);
        pg.texto('¡Gracias por su compra!', ANCHO / 2, ALTO - 30, 9.5, { negrita: true, color: color, alin: 'centro' });
        pg.texto(d.pie || '', ANCHO / 2, ALTO - 17, 7, { color: gris, alin: 'centro' });
        if (paginas.length > 1) pg.texto((i + 1) + '/' + paginas.length, ANCHO - MARGEN, ALTO - 17, 7, { color: gris, alin: 'der' });
      });

      return armarPdf(paginas, logo);
    });
  }

  window.CuadreFactura = { crear: crear, _anchoTexto: anchoTexto };
})();
