(function () {
  'use strict';

  function color(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function wrap(ctx, text, x, y, max, lineHeight) {
    if (!text) return y;
    var words = String(text).split(' ');
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var trial = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(trial).width > max && line) {
        ctx.fillText(line, x, y);
        y += lineHeight;
        line = words[i];
      } else {
        line = trial;
      }
    }
    if (line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
    }
    return y;
  }

  function drawTrack(ctx, points, x, y, w, h, text, accent, muted) {
    if (!points || points.length < 2) {
      ctx.fillStyle = muted;
      ctx.font = '700 28px Segoe UI, sans-serif';
      ctx.fillText('Sem traçado de GPS', x, y + h / 2);
      return;
    }
    var minLat = Infinity;
    var maxLat = -Infinity;
    var minLon = Infinity;
    var maxLon = -Infinity;
    points.forEach(function (point) {
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lon < minLon) minLon = point.lon;
      if (point.lon > maxLon) maxLon = point.lon;
    });
    var spanLat = maxLat - minLat || 0.001;
    var spanLon = maxLon - minLon || 0.001;
    var lat0 = ((minLat + maxLat) / 2) * Math.PI / 180;
    var aspect = (spanLon * Math.cos(lat0)) / spanLat;
    var boxAspect = w / h;
    var dw = w;
    var dh = h;
    var ox = x;
    var oy = y;
    if (aspect > boxAspect) {
      dh = w / aspect;
      oy = y + (h - dh) / 2;
    } else {
      dw = h * aspect;
      ox = x + (w - dw) / 2;
    }
    function xy(point) {
      return [
        ox + ((point.lon - minLon) / spanLon) * dw,
        oy + ((maxLat - point.lat) / spanLat) * dh
      ];
    }
    ctx.beginPath();
    points.forEach(function (point, index) {
      var spot = xy(point);
      if (index === 0) ctx.moveTo(spot[0], spot[1]);
      else ctx.lineTo(spot[0], spot[1]);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    var start = xy(points[0]);
    var end = xy(points[points.length - 1]);
    ctx.fillStyle = text;
    ctx.beginPath();
    ctx.arc(start[0], start[1], 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(end[0], end[1], 12, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(model) {
    var canvas = document.createElement('canvas');
    var width = 1080;
    var height = 1440;
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var bg = color('--bg', '#000000');
    var text = color('--text', '#ffb300');
    var accent = color('--accent', '#ff6d00');
    var muted = color('--muted', '#f0d48a');
    var cutout = color('--cutout', '#141414');
    var line = color('--line', '#3a3324');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, 18, height);
    var x = 72;
    var y = 96;
    ctx.fillStyle = muted;
    ctx.font = '700 22px Segoe UI, sans-serif';
    ctx.fillText('VELOCÍMETRO ROTA', x, y);
    y += 78;
    ctx.fillStyle = text;
    ctx.font = '900 68px Segoe UI, sans-serif';
    ctx.fillText(model.km || '0,0 km', x, y);
    y += 52;
    ctx.fillStyle = muted;
    ctx.font = '700 28px Segoe UI, sans-serif';
    y = wrap(ctx, model.when || '', x, y, 930, 38);
    y = wrap(ctx, model.meta || '', x, y + 6, 930, 38);
    y += 28;
    var mapHeight = 460;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, 936, mapHeight, 24);
    else ctx.rect(x, y, 936, mapHeight);
    ctx.fillStyle = cutout;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = line;
    ctx.stroke();
    drawTrack(ctx, model.track || [], x + 36, y + 36, 864, mapHeight - 72, text, accent, muted);
    y += mapHeight + 52;
    ctx.textAlign = 'left';
    ctx.fillStyle = text;
    ctx.font = '700 30px Segoe UI, sans-serif';
    [model.places, model.vehicle, model.formula, model.liters, model.split, model.planned, model.extra].forEach(function (row) {
      if (!row) return;
      y = wrap(ctx, row, x, y, 930, 42);
      y += 14;
    });
    ctx.fillStyle = muted;
    ctx.font = '700 24px Segoe UI, sans-serif';
    wrap(ctx, model.footer || 'Estimativa. Não é cupom fiscal.', x, height - 96, 930, 32);
    return canvas;
  }

  function blobOf(canvas) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/png');
    });
  }

  function download(blob) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'recibo-rota.png';
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function share(canvas) {
    return blobOf(canvas).then(function (blob) {
      var file = new File([blob], 'recibo-rota.png', { type: 'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: 'Recibo da viagem' }).catch(function (error) {
          if (error && error.name === 'AbortError') return;
          download(blob);
        });
      }
      download(blob);
    });
  }

  function printPdf(canvas) {
    var frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    document.body.appendChild(frame);
    var doc = frame.contentDocument;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><title>Recibo</title><style>@page{margin:12mm}html,body{margin:0;background:#000}img{width:100%;height:auto;display:block}</style></head><body><img alt="Recibo da viagem"></body></html>');
    doc.close();
    var image = doc.querySelector('img');
    image.onload = function () {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(function () { frame.remove(); }, 1000);
    };
    image.src = canvas.toDataURL('image/png');
  }

  window.RotaReceipt = { draw: draw, share: share, printPdf: printPdf };
})();
