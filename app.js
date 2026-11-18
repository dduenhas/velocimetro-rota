(function () {
  'use strict';

  var THEMES = {
    amber: { label: 'Âmbar', color: '#000000' },
    stealth: { label: 'Stealth', color: '#0A0D10' },
    red: { label: 'Vermelho', color: '#000000' },
    daylight: { label: 'Dia', color: '#F4F5F7' },
    sunlight: { label: 'Sol', color: '#000000' }
  };

  var MAX_SPEED = 220;
  var MODE_PANEL = 0;
  var MODE_NAV = 1;
  var MODE_FOCUS = 2;
  var MODE_HUD = 3;
  var ARC_START = -120;
  var ARC_SWEEP = 240;
  var STOP_KMH = 1.5;
  var KMH_TO_MPH = 0.621371;
  var WEATHER_MAX_AGE = 20 * 60 * 1000;
  var WEATHER_MOVE_KM = 8;
  var HISTORY_LIMIT = 90;
  var OFF_ROUTE_KM = 0.08;

  var state = {
    theme: 'amber',
    hud: false,
    focus: 0,
    instrument: '',
    stopwatch: { running: false, elapsed: 0, startedAt: 0 },
    timer: { running: false, remaining: 5 * 60 * 1000, duration: 5 * 60 * 1000, endsAt: 0, fired: false },
    alarm: { hour: 7, minute: 0, armed: false, firedKey: '' },
    toolActionsKey: '',
    demo: false,
    displayKmh: 0,
    samples: [],
    gps: 'aguardando',
    battery: null,
    weather: null,
    trip: null,
    history: [],
    lastWeatherAt: null,
    installPrompt: null,
    vehicle: null,
    route: null,
    draft: { origin: null, destination: null, route: null },
    searchTimer: null,
    receiptCanvas: null
  };

  var watchId = null;
  var demoTimer = null;
  var demoT = 0;
  var wakeLock = null;
  var lastFix = null;

  var els = {};

  function $(id) { return document.getElementById(id); }

  function readStore(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {}
  }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var p1 = lat1 * Math.PI / 180;
    var p2 = lat2 * Math.PI / 180;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function formatKm(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
  }

  function padClock(date) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatWhen(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatClock(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function movingMs(trip, now) {
    if (!trip) return 0;
    var pausedExtra = trip.paused && trip.pauseStartedAt ? now - trip.pauseStartedAt : 0;
    return Math.max(0, now - trip.startedAt - (trip.pausedMs || 0) - pausedExtra);
  }

  function polar(deg, radius) {
    var rad = deg * Math.PI / 180;
    return [180 + Math.sin(rad) * radius, 180 - Math.cos(rad) * radius];
  }

  function arcPath(radius, start, end) {
    var a = polar(start, radius);
    var b = polar(end, radius);
    var large = Math.abs(end - start) > 180 ? 1 : 0;
    return 'M ' + a[0].toFixed(2) + ' ' + a[1].toFixed(2) +
      ' A ' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' +
      b[0].toFixed(2) + ' ' + b[1].toFixed(2);
  }

  function needleAngle(kmh) {
    var clamped = Math.max(0, Math.min(MAX_SPEED, kmh));
    return ARC_START + (clamped / MAX_SPEED) * ARC_SWEEP;
  }

  function buildDial() {
    var ns = 'http://www.w3.org/2000/svg';
    var ticks = $('ticks');
    $('track').setAttribute('d', arcPath(150, ARC_START, ARC_START + ARC_SWEEP));
    var redStart = ARC_START + (180 / MAX_SPEED) * ARC_SWEEP;
    $('redline').setAttribute('d', arcPath(150, redStart, ARC_START + ARC_SWEEP));

    for (var v = 0; v <= MAX_SPEED; v += 10) {
      var rot = needleAngle(v);
      var major = v % 20 === 0;
      var hot = v >= 180;
      var line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', '180');
      line.setAttribute('x2', '180');
      line.setAttribute('y1', major ? '16' : '20');
      line.setAttribute('y2', major ? '32' : '28');
      line.setAttribute('transform', 'rotate(' + rot + ' 180 180)');
      line.setAttribute('class', hot ? 'tick tick-hot' : (major ? 'tick tick-major' : 'tick tick-minor'));
      ticks.appendChild(line);

      if (v % 40 === 0 || v === MAX_SPEED) {
        var point = polar(rot, 118);
        var text = document.createElementNS(ns, 'text');
        text.setAttribute('x', point[0].toFixed(1));
        text.setAttribute('y', point[1].toFixed(1));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('class', hot ? 'num num-hot' : 'num');
        text.textContent = String(v);
        ticks.appendChild(text);
      }
    }
  }

  function renderSpeed() {
    var kmh = state.displayKmh;
    var shown = Math.round(kmh);
    if (shown > 999) shown = 999;
    els.kmh.textContent = String(shown);
    els.mph.textContent = Math.round(kmh * KMH_TO_MPH) + ' mph';
    var angle = needleAngle(kmh);
    $('needle').setAttribute('transform', 'rotate(' + angle.toFixed(2) + ' 180 180)');
    var progress = $('progress');
    if (kmh < 0.5) {
      progress.setAttribute('d', '');
    } else {
      progress.setAttribute('d', arcPath(150, ARC_START, angle));
    }
  }

  function pushSample(kmh) {
    if (!isFinite(kmh) || kmh < 0) kmh = 0;
    if (kmh > 280) return;
    state.samples.push(kmh);
    if (state.samples.length > 5) state.samples.shift();
    var sum = 0;
    for (var i = 0; i < state.samples.length; i++) sum += state.samples[i];
    var avg = sum / state.samples.length;
    state.displayKmh = avg < STOP_KMH ? 0 : avg;
    renderSpeed();
  }

  function renderGps() {
    var labels = {
      aguardando: 'Aguardando GPS',
      ativo: 'GPS ativo',
      negado: 'GPS negado',
      sem: 'Sem sinal',
      simulacao: 'Simulação'
    };
    els.gpsPill.textContent = labels[state.gps] || labels.aguardando;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatSpan(ms) {
    ms = Math.max(0, Math.floor(ms || 0));
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return pad2(m) + ':' + pad2(s);
  }

  function renderClock() {
    var now = new Date();
    els.clock.textContent = padClock(now);
    els.clock.dateTime = now.toISOString();
    if (els.clockDigital) els.clockDigital.textContent = padClock(now);
    var seconds = now.getSeconds();
    var minutes = now.getMinutes() + seconds / 60;
    var hours = (now.getHours() % 12) + minutes / 60;
    var hourHand = $('hourHand');
    var minuteHand = $('minuteHand');
    var secondHand = $('secondHand');
    if (hourHand) hourHand.setAttribute('transform', 'rotate(' + (hours * 30).toFixed(2) + ' 180 180)');
    if (minuteHand) minuteHand.setAttribute('transform', 'rotate(' + (minutes * 6).toFixed(2) + ' 180 180)');
    if (secondHand) secondHand.setAttribute('transform', 'rotate(' + (seconds * 6).toFixed(2) + ' 180 180)');
    renderTools(now);
  }

  function buildClock() {
    var ns = 'http://www.w3.org/2000/svg';
    var ticks = $('clockTicks');
    if (!ticks) return;
    for (var i = 0; i < 12; i++) {
      var line = document.createElementNS(ns, 'line');
      var major = i % 3 === 0;
      line.setAttribute('x1', '180');
      line.setAttribute('x2', '180');
      line.setAttribute('y1', major ? '18' : '24');
      line.setAttribute('y2', major ? '40' : '34');
      line.setAttribute('transform', 'rotate(' + (i * 30) + ' 180 180)');
      line.setAttribute('class', major ? 'tick tick-major' : 'tick tick-minor');
      ticks.appendChild(line);
    }
  }

  function renderBattery(source) {
    if (state.demo && source !== 'demo') return;
    if (!source || source === 'unsupported') {
      els.batteryText.textContent = 'N/D';
      els.batIcon.hidden = true;
      return;
    }
    var level = source.level;
    var charging = source.charging;
    if (source === 'demo') {
      level = state.demoLevel;
      charging = state.demoCharging;
    }
    els.batIcon.hidden = false;
    var pct = Math.round((level || 0) * 100);
    els.batteryText.textContent = pct + '%' + (charging ? ' ⚡' : '');
    $('batFill').setAttribute('width', String(Math.max(0.8, 20 * (level || 0))));
  }

  function weatherName(code) {
    if (code === 0) return 'Céu limpo';
    if (code === 1 || code === 2) return 'Parcialmente nublado';
    if (code === 3) return 'Nublado';
    if (code === 45 || code === 48) return 'Neblina';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'Chuva';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Neve';
    if (code >= 95) return 'Tempestade';
    return 'Tempo';
  }

  function weatherSvg(code) {
    if (code === 0) {
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/></g></svg>';
    }
    if (code === 1 || code === 2) {
      return '<svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="3" fill="currentColor"/><path fill="currentColor" d="M8 16.5h9.2a3.3 3.3 0 0 0 .2-6.6 4.6 4.6 0 0 0-8.8 1.2A3 3 0 0 0 8 16.5z"/></svg>';
    }
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) {
      return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 13h10.2a3.2 3.2 0 0 0 .2-6.4 4.5 4.5 0 0 0-8.6 1.1A2.8 2.8 0 0 0 7 13z"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 16.5 7 20M12 16.5 11 20M16 16.5 15 20"/></g></svg>';
    }
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
      return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 12.5h10.2a3.2 3.2 0 0 0 .2-6.4 4.5 4.5 0 0 0-8.6 1.1A2.8 2.8 0 0 0 7 12.5z"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 16v4M12 15.5v4M15 16v4"/></g></svg>';
    }
    return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6.5 17h11a3.8 3.8 0 0 0 .3-7.6 5.2 5.2 0 0 0-10 1.3A3.2 3.2 0 0 0 6.5 17z"/></svg>';
  }

  function renderWeather() {
    var data = state.weather;
    var simulated = false;
    if (!data && state.demo) {
      simulated = true;
      data = {
        temp: 24,
        code: 2,
        hours: [
          { label: '15h', temp: 24 },
          { label: '16h', temp: 23 },
          { label: '17h', temp: 22 },
          { label: '18h', temp: 21 }
        ]
      };
    }
    els.hours.replaceChildren();
    if (!data) {
      els.weatherIcon.innerHTML = weatherSvg(3);
      els.weatherTemp.textContent = '--°';
      els.weatherDesc.textContent = 'Clima indisponível';
      return;
    }
    els.weatherIcon.innerHTML = weatherSvg(data.code);
    els.weatherTemp.textContent = Math.round(data.temp) + '°';
    els.weatherDesc.textContent = weatherName(data.code) + (data.place ? ' · ' + data.place : '') + (simulated ? ' · simulado' : '');
    (data.hours || []).forEach(function (hour) {
      var chip = document.createElement('div');
      chip.className = 'hour';
      var label = document.createElement('span');
      label.textContent = hour.label;
      var value = document.createElement('b');
      value.textContent = Math.round(hour.temp) + '°';
      chip.append(label, value);
      els.hours.appendChild(chip);
    });
  }

  function shouldRefreshWeather(lat, lon) {
    if (!state.weather || !state.weather.at) return true;
    if (Date.now() - state.weather.at > WEATHER_MAX_AGE) return true;
    if (lat == null || state.weather.lat == null) return false;
    return haversine(state.weather.lat, state.weather.lon, lat, lon) > WEATHER_MOVE_KM;
  }

  function ufCode(code) {
    var parts = String(code || '').split('-');
    var uf = parts[parts.length - 1];
    return /^[A-Za-z]{2}$/.test(uf) ? uf.toUpperCase() : '';
  }

  function formatPlace(data) {
    var city = data.locality || '';
    var admins = (data.localityInfo && data.localityInfo.administrative) || [];
    if (!city) {
      for (var i = 0; i < admins.length; i++) {
        if (admins[i].adminLevel === 8 && admins[i].name) {
          city = admins[i].name;
          break;
        }
      }
    }
    if (!city && data.city && data.city.indexOf('Região') !== 0) city = data.city;
    var uf = ufCode(data.principalSubdivisionCode);
    if (city && uf) return city + '/' + uf;
    return city || uf;
  }

  function rememberPlace(place) {
    if (!place || !state.weather || state.weather.place === place) return;
    state.weather.place = place;
    writeStore('rota.weather', state.weather);
    renderWeather();
  }

  function fetchPlace(lat, lon) {
    var url = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client');
    url.searchParams.set('latitude', lat.toFixed(3));
    url.searchParams.set('longitude', lon.toFixed(3));
    url.searchParams.set('localityLanguage', 'pt');
    fetch(url.toString())
      .then(function (response) { if (!response.ok) throw new Error('lugar'); return response.json(); })
      .then(function (data) { rememberPlace(formatPlace(data)); })
      .catch(function () {});
  }

  function fetchWeather(lat, lon) {
    if (state.demo || !navigator.onLine) return;
    var refresh = shouldRefreshWeather(lat, lon);
    if (!refresh) {
      if (state.weather && !state.weather.place) fetchPlace(lat, lon);
      return;
    }
    var url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', lat.toFixed(3));
    url.searchParams.set('longitude', lon.toFixed(3));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set('hourly', 'temperature_2m,weather_code');
    url.searchParams.set('forecast_hours', '6');
    url.searchParams.set('timezone', 'auto');
    fetch(url.toString())
      .then(function (response) { if (!response.ok) throw new Error('clima'); return response.json(); })
      .then(function (data) {
        var current = data.current || {};
        var times = (data.hourly && data.hourly.time) || [];
        var temps = (data.hourly && data.hourly.temperature_2m) || [];
        var now = Date.now() - 30 * 60 * 1000;
        var moved = state.weather && state.weather.lat != null
          && haversine(state.weather.lat, state.weather.lon, lat, lon) > WEATHER_MOVE_KM;
        var keptPlace = !moved && state.weather ? state.weather.place : '';
        var hours = [];
        for (var i = 0; i < times.length && hours.length < 4; i++) {
          var stamp = Date.parse(times[i]);
          if (!isFinite(stamp) || stamp < now) continue;
          hours.push({
            label: String(times[i]).slice(11, 13) + 'h',
            temp: temps[i]
          });
        }
        state.weather = {
          temp: current.temperature_2m,
          code: current.weather_code,
          hours: hours,
          lat: lat,
          lon: lon,
          place: keptPlace || '',
          at: Date.now()
        };
        writeStore('rota.weather', state.weather);
        renderWeather();
        fetchPlace(lat, lon);
      })
      .catch(function () { renderWeather(); });
  }

  function renderTrip() {
    var trip = state.trip;
    var now = Date.now();
    if (!trip) {
      els.tripState.textContent = 'Parada';
      els.tripKm.textContent = formatKm(0);
      els.tripTime.textContent = '0 min';
      els.tripAvg.textContent = '— km/h méd';
      syncTripChrome(false, false);
      return;
    }
    var km = trip.distanceKm || 0;
    var ms = movingMs(trip, now);
    var minutes = Math.max(0, Math.round(ms / 60000));
    var hours = ms / 3600000;
    els.tripKm.textContent = formatKm(km);
    if (ms < 60000) els.tripTime.textContent = Math.round(ms / 1000) + ' s';
    else els.tripTime.textContent = minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
    els.tripAvg.textContent = ms >= 3000 ? Math.round(km / hours) + ' km/h méd' : '— km/h méd';
    if (trip.simulated) els.tripState.textContent = trip.paused ? 'Pausada' : 'Simulação';
    else if (trip.paused) els.tripState.textContent = 'Pausada';
    else if (trip.track && trip.track.length) els.tripState.textContent = 'Trilha ' + trip.track.length;
    else els.tripState.textContent = 'Sem GPS';
    syncTripChrome(true, !!trip.paused);
  }

  function syncTripChrome(running, paused) {
    var label = running && paused ? 'Retomar' : 'Pausar';
    els.pauseLabel.textContent = label;
    if (els.navPauseLabel) els.navPauseLabel.textContent = label;
    els.startTrip.disabled = running;
    els.pauseTrip.disabled = !running;
    els.finishTrip.disabled = !running;
    if (els.navStart) els.navStart.disabled = running;
    if (els.navPause) els.navPause.disabled = !running;
    if (els.navFinish) els.navFinish.disabled = !running;
    els.pauseTrip.classList.toggle('is-live', running && !paused);
    if (els.navPause) els.navPause.classList.toggle('is-live', running && !paused);
    if (els.tripCost) els.tripCost.textContent = tripCostText();
  }

  function saveTrip() {
    writeStore('rota.trip', state.trip);
  }

  function startTrip() {
    if (state.trip) return;
    state.trip = {
      id: String(Date.now()),
      startedAt: Date.now(),
      paused: false,
      pauseStartedAt: null,
      pausedMs: 0,
      distanceKm: 0,
      start: null,
      end: null,
      track: [],
      simulated: !!state.demo
    };
    lastFix = null;
    saveTrip();
    renderTrip();
    tap();
  }

  function pauseTrip() {
    if (!state.trip) return;
    var now = Date.now();
    if (state.trip.paused) {
      state.trip.pausedMs += now - (state.trip.pauseStartedAt || now);
      state.trip.paused = false;
      state.trip.pauseStartedAt = null;
      lastFix = null;
    } else {
      state.trip.paused = true;
      state.trip.pauseStartedAt = now;
    }
    saveTrip();
    renderTrip();
    tap();
  }

  function finishTrip() {
    if (!state.trip) return;
    var now = Date.now();
    if (state.trip.paused && state.trip.pauseStartedAt) {
      state.trip.pausedMs += now - state.trip.pauseStartedAt;
    }
    var measuredKm = state.trip.distanceKm || 0;
    var track = state.trip.track || [];
    var cost = costSnapshot(measuredKm);
    state.history.unshift({
      id: state.trip.id,
      startedAt: state.trip.startedAt,
      endedAt: now,
      distanceKm: measuredKm,
      movingMs: movingMs(state.trip, now),
      start: state.trip.start || null,
      end: state.trip.end || null,
      track: track,
      plannedGeometry: track.length >= 2 ? null : (state.route && state.route.geometry) || null,
      plannedKm: state.route && state.route.distanceKm ? state.route.distanceKm : null,
      origin: state.route && state.route.origin ? state.route.origin.label : '',
      destination: state.route && state.route.destination ? state.route.destination.label : '',
      simulated: !!state.trip.simulated,
      cost: cost
    });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    state.trip = null;
    lastFix = null;
    writeStore('rota.history', state.history);
    writeStore('rota.trip', null);
    renderTrip();
    renderHistory();
    tap();
  }

  function noteTrack(lat, lon) {
    var trip = state.trip;
    if (!trip || trip.paused) return;
    var point = {
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5
    };
    var changed = false;
    if (!trip.start) {
      trip.start = point;
      changed = true;
    }
    trip.end = point;
    if (!trip.track) trip.track = [];
    var last = trip.track[trip.track.length - 1];
    if (!last || haversine(last.lat, last.lon, point.lat, point.lon) >= 0.08) {
      trip.track.push(point);
      changed = true;
      if (trip.track.length > 400) {
        var slim = [];
        for (var i = 0; i < trip.track.length; i += 2) slim.push(trip.track[i]);
        var tail = trip.track[trip.track.length - 1];
        if (slim[slim.length - 1] !== tail) slim.push(tail);
        trip.track = slim;
      }
    }
    if (changed) saveTrip();
  }

  function addDistance(km) {
    if (!state.trip || state.trip.paused || !(km > 0)) return;
    if (state.demo) state.trip.simulated = true;
    state.trip.distanceKm += km;
    saveTrip();
    renderTrip();
  }

  function onPosition(pos) {
    if (state.demo) return;
    var coords = pos.coords;
    state.gps = 'ativo';
    renderGps();
    var kmh = null;
    if (typeof coords.speed === 'number' && coords.speed >= 0 && isFinite(coords.speed)) {
      kmh = coords.speed * 3.6;
    }
    var now = pos.timestamp || Date.now();
    if (lastFix) {
      var dt = (now - lastFix.t) / 1000;
      var dist = haversine(lastFix.lat, lastFix.lon, coords.latitude, coords.longitude);
      var segmentKmh = dt > 0 ? (dist / dt) * 3600 : 0;
      if (kmh == null) kmh = segmentKmh;
      var badAccuracy = typeof coords.accuracy === 'number' && coords.accuracy > 50;
      var jump = segmentKmh > 250 || dt > 30 || dt < 0.3;
      if (!badAccuracy && !jump) {
        noteTrack(coords.latitude, coords.longitude);
        if (dist >= 0.002) addDistance(dist);
      }
    } else if (!(typeof coords.accuracy === 'number' && coords.accuracy > 50)) {
      noteTrack(coords.latitude, coords.longitude);
    }
    lastFix = { lat: coords.latitude, lon: coords.longitude, t: now };
    if (kmh == null) kmh = 0;
    if (typeof coords.accuracy === 'number' && coords.accuracy > 80 && kmh < 8) kmh = 0;
    pushSample(kmh);
    fetchWeather(coords.latitude, coords.longitude);
    if (state.focus === MODE_NAV) renderNav();
  }

  function onPositionError(error) {
    if (state.demo) return;
    state.gps = error && error.code === 1 ? 'negado' : 'sem';
    renderGps();
  }

  function startGps() {
    if (state.demo || watchId != null) return;
    if (!navigator.geolocation) {
      state.gps = 'sem';
      renderGps();
      return;
    }
    state.gps = 'aguardando';
    renderGps();
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000
    });
  }

  function stopGps() {
    if (watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
    lastFix = null;
  }

  function startDemo() {
    stopDemo();
    state.gps = 'simulacao';
    renderGps();
    demoTimer = setInterval(function () {
      demoT += 0.2;
      var kmh = Math.max(0, 58 + 52 * Math.sin(demoT * 0.17) + 18 * Math.sin(demoT * 0.05));
      pushSample(kmh);
      addDistance((kmh / 3600) * 0.2);
      state.demoLevel = 0.55 + 0.2 * Math.sin(demoT * 0.08);
      state.demoCharging = Math.sin(demoT * 0.05) > 0.2;
      renderBattery('demo');
    }, 200);
    renderWeather();
  }

  function stopDemo() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
    state.samples = [];
    state.displayKmh = 0;
    renderSpeed();
  }

  function setDemo(on) {
    state.demo = !!on;
    writeStore('rota.demo', state.demo);
    els.demoSwitch.setAttribute('aria-checked', state.demo ? 'true' : 'false');
    els.demoSwitch.querySelector('.switch-text').textContent = state.demo ? 'On' : 'Off';
    if (state.demo) {
      stopGps();
      startDemo();
    } else {
      stopDemo();
      renderBattery(state.battery || 'unsupported');
      renderWeather();
      startGps();
    }
  }

  function applyTheme(name) {
    if (!THEMES[name]) name = 'amber';
    state.theme = name;
    document.documentElement.dataset.theme = name;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES[name].color);
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute('content', name === 'daylight' ? 'light' : 'dark');
    els.themeChip.textContent = THEMES[name].label;
    var chips = document.querySelectorAll('[data-theme-choice]');
    chips.forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.getAttribute('data-theme-choice') === name ? 'true' : 'false');
    });
    writeStore('rota.theme', name);
    renderAreaStatus();
  }

  var screenStack = [];

  function hidePlannerMap() {
    if (!els.routePlanner) return;
    els.routePlanner.hidden = true;
    els.placeResults.replaceChildren();
    if (plannerLeaflet) {
      plannerLeaflet.remove();
      plannerLeaflet = null;
      plannerLine = null;
    }
  }

  function labelBacks() {
    var prev = screenStack.length > 1 ? screenStack[screenStack.length - 2] : '';
    var label = prev === 'screenAreas' ? 'Áreas' : (prev ? 'Voltar' : 'Painel');
    document.querySelectorAll('.screen-back').forEach(function (button) {
      button.textContent = '‹ ' + label;
    });
  }

  function presentTop() {
    var id = screenStack[screenStack.length - 1] || '';
    var onDeck = id && id !== 'route';
    ['screenAreas', 'screenHistory', 'screenVehicle', 'screenSettings'].forEach(function (sid) {
      var node = $(sid);
      if (node) node.hidden = sid !== id;
    });
    if (els.deck) els.deck.hidden = !onDeck;
    if (id === 'route') els.routePlanner.hidden = false;
    else hidePlannerMap();
    document.body.style.overflow = id ? 'hidden' : '';
    labelBacks();
    if (id === 'screenHistory' || id === 'screenAreas') renderHistory();
  }

  function openRoot(id) {
    hidePlannerMap();
    screenStack = [id];
    presentTop();
    tap();
  }

  function openScreen(id) {
    if (screenStack[screenStack.length - 1] !== id) screenStack.push(id);
    presentTop();
    tap();
  }

  function closeAllScreens() {
    screenStack = [];
    hidePlannerMap();
    if (els.deck) els.deck.hidden = true;
    document.body.style.overflow = '';
  }

  function backScreen() {
    if (els.receiptSheet && !els.receiptSheet.hidden) { closeReceipt(); return; }
    if (els.routeMap && !els.routeMap.hidden) { closeRoute(); return; }
    if (!screenStack.length) return;
    var leaving = screenStack.pop();
    if (leaving === 'route') hidePlannerMap();
    if (!screenStack.length) {
      if (els.deck) els.deck.hidden = true;
      document.body.style.overflow = '';
      return;
    }
    presentTop();
  }

  function setFocus(mode) {
    mode = ((mode % 4) + 4) % 4;
    state.focus = mode;
    state.hud = mode === MODE_HUD;
    document.body.classList.toggle('is-focus', mode === MODE_FOCUS);
    document.body.classList.toggle('is-hud', mode === MODE_HUD);
    document.body.classList.toggle('is-nav', mode === MODE_NAV);
    if (els.companion) els.companion.hidden = mode !== MODE_FOCUS;
    if (els.navPane) els.navPane.hidden = mode !== MODE_NAV;
    if (els.toolPicker && mode !== MODE_FOCUS) els.toolPicker.hidden = true;
    els.gauge.setAttribute('aria-pressed', mode ? 'true' : 'false');
    if (els.hudHint) {
      if (mode === MODE_NAV) els.hudHint.textContent = 'Toque para o relógio';
      else if (mode === MODE_FOCUS) els.hudHint.textContent = 'Toque para o velocímetro';
      else els.hudHint.textContent = 'Toque para o painel';
    }
    if (mode === MODE_FOCUS) renderClock();
    if (mode === MODE_NAV) ensureNav();
    else navFitted = false;
  }

  function openDrawer() {
    openRoot('screenAreas');
  }

  function closeDrawer() {
    closeAllScreens();
  }

  function renderHistory() {
    var list = els.historyList;
    list.replaceChildren();
    var total = 0;
    state.history.forEach(function (trip) { total += trip.distanceKm || 0; });
    var countLabel = state.history.length
      ? state.history.length + (state.history.length === 1 ? ' viagem' : ' viagens') + ' · ' + formatKm(total) + ' km'
      : 'Nenhuma viagem salva';
    els.historySummary.textContent = countLabel;
    renderAreaStatus();
    renderCostTotals();

    if (!state.history.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nenhuma viagem neste aparelho.';
      list.appendChild(empty);
      return;
    }

    state.history.forEach(function (trip) {
      var row = document.createElement('article');
      row.className = 'plate trip-row';
      var copy = document.createElement('div');
      var when = document.createElement('p');
      when.className = 'when';
      when.textContent = formatWhen(trip.startedAt) + ' → ' + formatClock(trip.endedAt);
      var dist = document.createElement('p');
      dist.className = 'trip-km';
      var detail = formatKm(trip.distanceKm) + ' km';
      if (trip.movingMs) detail += ' · ' + formatSpan(trip.movingMs);
      dist.textContent = detail;
      copy.append(when, dist);
      if (trip.cost) {
        var money = document.createElement('p');
        money.className = 'trip-coords';
        money.textContent = formatBRL(trip.cost.totalCents) + shareSuffix(trip.cost);
        copy.appendChild(money);
      }
      var note = document.createElement('p');
      note.className = 'trip-coords';
      if (trip.track && trip.track.length >= 2) {
        var from = trip.start ? trip.start.lat.toFixed(3) + ', ' + trip.start.lon.toFixed(3) : '—';
        var to = trip.end ? trip.end.lat.toFixed(3) + ', ' + trip.end.lon.toFixed(3) : from;
        note.textContent = from + ' → ' + to;
      } else if (trip.simulated) {
        note.textContent = 'Simulação não grava o caminho';
      } else {
        note.textContent = 'Sem percurso de GPS';
      }
      copy.appendChild(note);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'skeuo icon-btn';
      remove.textContent = 'Excluir';
      remove.addEventListener('click', function () {
        state.history = state.history.filter(function (item) { return item.id !== trip.id; });
        writeStore('rota.history', state.history);
        renderHistory();
        tap();
      });
      var buttons = document.createElement('div');
      buttons.className = 'trip-buttons';
      var receiptBtn = document.createElement('button');
      receiptBtn.type = 'button';
      receiptBtn.className = 'skeuo icon-btn';
      receiptBtn.textContent = 'Recibo';
      receiptBtn.addEventListener('click', function () {
        openReceipt(trip);
        tap();
      });
      buttons.appendChild(receiptBtn);
      var route = (trip.track && trip.track.length >= 2) || (trip.plannedGeometry && trip.plannedGeometry.length >= 2);
      if (route) {
        var mapBtn = document.createElement('button');
        mapBtn.type = 'button';
        mapBtn.className = 'skeuo icon-btn';
        mapBtn.textContent = 'Mapa';
        mapBtn.addEventListener('click', function () {
          openRoute(trip);
          tap();
        });
        buttons.appendChild(mapBtn);
      }
      buttons.appendChild(remove);
      row.append(copy, buttons);
      list.appendChild(row);
    });
  }

  function openExternal(kind) {
    var android = /Android/i.test(navigator.userAgent || '');
    var ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    var web = kind === 'maps' ? 'https://maps.google.com/maps' : 'https://open.spotify.com';
    var scheme = kind === 'maps' ? 'comgooglemaps://' : 'spotify://';
    var pkg = kind === 'maps' ? 'com.google.android.apps.maps' : 'com.spotify.music';
    tap();
    if (android) {
      var host = kind === 'maps' ? 'maps.google.com/maps' : 'open.spotify.com/';
      location.href = 'intent://' + host + '#Intent;scheme=https;package=' + pkg +
        ';S.browser_fallback_url=' + encodeURIComponent(web) + ';end';
      return;
    }
    if (ios) {
      var started = Date.now();
      location.href = scheme;
      setTimeout(function () {
        if (document.visibilityState === 'visible' && Date.now() - started < 1800) location.href = web;
      }, 900);
      return;
    }
    location.href = web;
  }

  function tap() {
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function requestWake() {
    if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  function bindBattery() {
    if (!navigator.getBattery) {
      state.battery = null;
      renderBattery('unsupported');
      return;
    }
    navigator.getBattery().then(function (battery) {
      state.battery = battery;
      var draw = function () { renderBattery(battery); };
      draw();
      battery.addEventListener('levelchange', draw);
      battery.addEventListener('chargingchange', draw);
    }).catch(function () {
      renderBattery('unsupported');
    });
  }

  function bindInstall() {
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      state.installPrompt = event;
      els.installBtn.hidden = false;
    });
    els.installBtn.addEventListener('click', function () {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      state.installPrompt.userChoice.finally(function () {
        state.installPrompt = null;
        els.installBtn.hidden = true;
      });
    });
  }

  function enterImmersive() {
    if (!window.matchMedia('(display-mode: standalone)').matches) return;
    if (document.fullscreenElement) return;
    var root = document.documentElement;
    if (!root.requestFullscreen) return;
    var pending = root.requestFullscreen({ navigationUI: 'hide' });
    if (pending && pending.catch) pending.catch(function () {});
  }

  function cacheShell() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./service-worker.js', {
      scope: './',
      updateViaCache: 'none'
    }).catch(function () {});
  }

  function audioCtx() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!state.audio) state.audio = new Ctx();
    if (state.audio.state === 'suspended') state.audio.resume();
    return state.audio;
  }

  function ring() {
    if (els.toolFace) els.toolFace.classList.add('is-ringing');
    clearTimeout(state.ringTimer);
    state.ringTimer = setTimeout(function () {
      if (els.toolFace) els.toolFace.classList.remove('is-ringing');
    }, 4000);
    try {
      if (navigator.vibrate) navigator.vibrate([180, 80, 180, 80, 180]);
      var ctx = audioCtx();
      if (!ctx) return;
      [0, 0.28, 0.56].forEach(function (at) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.frequency.value = 880;
        osc.connect(gain);
        gain.connect(ctx.destination);
        var start = ctx.currentTime + at;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
        osc.start(start);
        osc.stop(start + 0.24);
      });
    } catch (error) {}
  }

  function stopwatchMs() {
    var sw = state.stopwatch;
    return sw.elapsed + (sw.running ? Date.now() - sw.startedAt : 0);
  }

  function timerMs() {
    var timer = state.timer;
    if (!timer.running) return timer.remaining;
    return Math.max(0, timer.endsAt - Date.now());
  }

  function checkTimer() {
    var timer = state.timer;
    if (!timer.running) return;
    if (timerMs() > 0) return;
    timer.running = false;
    timer.remaining = 0;
    if (!timer.fired) {
      timer.fired = true;
      ring();
    }
  }

  function checkAlarm(now) {
    var alarm = state.alarm;
    if (!alarm.armed) return;
    if (now.getHours() !== alarm.hour || now.getMinutes() !== alarm.minute) return;
    var key = now.toDateString() + '-' + alarm.hour + ':' + alarm.minute;
    if (alarm.firedKey === key) return;
    alarm.firedKey = key;
    writeStore('rota.alarm', alarm);
    ring();
  }

  function toolButton(label, action) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'skeuo';
    button.textContent = label;
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      audioCtx();
      action();
      state.toolActionsKey = '';
      renderTools(new Date());
      tap();
    });
    return button;
  }

  function buildToolActions() {
    var box = els.toolActions;
    box.replaceChildren();
    if (state.instrument === 'stopwatch') {
      box.appendChild(toolButton(state.stopwatch.running ? 'Pausar' : 'Iniciar', function () {
        var sw = state.stopwatch;
        if (sw.running) {
          sw.elapsed += Date.now() - sw.startedAt;
          sw.running = false;
        } else {
          sw.startedAt = Date.now();
          sw.running = true;
        }
      }));
      box.appendChild(toolButton('Zerar', function () {
        state.stopwatch = { running: false, elapsed: 0, startedAt: 0 };
      }));
    } else if (state.instrument === 'timer') {
      if (!state.timer.running) {
        box.appendChild(toolButton('−', function () {
          var next = Math.max(60000, state.timer.duration - 60000);
          state.timer.duration = next;
          state.timer.remaining = next;
          state.timer.fired = false;
        }));
        box.appendChild(toolButton('+', function () {
          var next = Math.min(180 * 60000, state.timer.duration + 60000);
          state.timer.duration = next;
          state.timer.remaining = next;
          state.timer.fired = false;
        }));
      }
      box.appendChild(toolButton(state.timer.running ? 'Pausar' : 'Iniciar', function () {
        var timer = state.timer;
        if (timer.running) {
          timer.remaining = timerMs();
          timer.running = false;
        } else {
          if (timer.remaining <= 0) timer.remaining = timer.duration;
          timer.endsAt = Date.now() + timer.remaining;
          timer.running = true;
          timer.fired = false;
        }
      }));
      box.appendChild(toolButton('Zerar', function () {
        state.timer.running = false;
        state.timer.remaining = state.timer.duration;
        state.timer.fired = false;
      }));
    } else if (state.instrument === 'alarm') {
      box.appendChild(toolButton('Hora', function () {
        state.alarm.hour = (state.alarm.hour + 1) % 24;
        state.alarm.firedKey = '';
        writeStore('rota.alarm', state.alarm);
      }));
      box.appendChild(toolButton('Min', function () {
        state.alarm.minute = (state.alarm.minute + 1) % 60;
        state.alarm.firedKey = '';
        writeStore('rota.alarm', state.alarm);
      }));
      box.appendChild(toolButton(state.alarm.armed ? 'Desarmar' : 'Armar', function () {
        state.alarm.armed = !state.alarm.armed;
        state.alarm.firedKey = '';
        writeStore('rota.alarm', state.alarm);
      }));
    }
  }

  function renderTools(now) {
    if (!els.toolFace) return;
    checkTimer();
    checkAlarm(now);
    if (!state.instrument) {
      els.toolFace.hidden = true;
      return;
    }
    els.toolFace.hidden = state.focus !== MODE_FOCUS;
    var names = { stopwatch: 'Cronômetro', timer: 'Temporizador', alarm: 'Alarme' };
    els.toolName.textContent = names[state.instrument] || '';
    var readout = '00:00';
    var key = state.instrument;
    if (state.instrument === 'stopwatch') {
      readout = formatSpan(stopwatchMs());
      key += state.stopwatch.running ? ':on' : ':off';
    } else if (state.instrument === 'timer') {
      readout = formatSpan(timerMs());
      key += (state.timer.running ? ':on' : ':off') + ':' + state.timer.duration;
    } else if (state.instrument === 'alarm') {
      readout = pad2(state.alarm.hour) + ':' + pad2(state.alarm.minute);
      key += (state.alarm.armed ? ':on:' : ':off:') + readout;
    }
    els.toolReadout.textContent = readout;
    if (key !== state.toolActionsKey) {
      state.toolActionsKey = key;
      buildToolActions();
    }
  }

  function setInstrument(name) {
    state.instrument = name || '';
    writeStore('rota.instrument', state.instrument);
    els.toolPicker.hidden = true;
    state.toolActionsKey = '';
    document.querySelectorAll('#toolPicker button').forEach(function (button) {
      button.setAttribute('aria-pressed', (button.getAttribute('data-tool') || '') === state.instrument ? 'true' : 'false');
    });
    renderTools(new Date());
  }

  var leafletPromise = null;
  var routeLeaflet = null;
  var navLeaflet = null;
  var navRouteLine = null;
  var navTrackLine = null;
  var navMarker = null;
  var navFitted = false;
  var plannerLeaflet = null;
  var plannerLine = null;
  var routeToken = 0;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './vendor/leaflet/leaflet.css';
      document.head.appendChild(link);
      var script = document.createElement('script');
      script.src = './vendor/leaflet/leaflet.js';
      script.onload = function () { resolve(); };
      script.onerror = function () {
        leafletPromise = null;
        reject(new Error('mapa'));
      };
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  function closeRoute() {
    els.routeMap.hidden = true;
    if (routeLeaflet) {
      routeLeaflet.remove();
      routeLeaflet = null;
    }
  }

  function openRoute(trip) {
    els.routeMap.hidden = false;
    var bits = [formatKm(trip.distanceKm) + ' km'];
    if (trip.movingMs) bits.push(formatSpan(trip.movingMs));
    els.mapMeta.textContent = bits.join(' · ');
    var points = trip.track && trip.track.length ? trip.track.slice() : [];
    if (points.length < 2 && trip.plannedGeometry && trip.plannedGeometry.length >= 2) {
      points = trip.plannedGeometry.slice();
    }
    if (trip.end && points.length) {
      var lastPoint = points[points.length - 1];
      if (lastPoint.lat !== trip.end.lat || lastPoint.lon !== trip.end.lon) points.push(trip.end);
    }
    if (!navigator.onLine) {
      els.mapNote.hidden = false;
      els.mapNote.textContent = 'O mapa precisa de internet. Quilômetros, tempo e coordenadas continuam salvos.';
      $('mapCanvas').hidden = true;
      return;
    }
    els.mapNote.hidden = true;
    $('mapCanvas').hidden = false;
    loadLeaflet().then(function () {
      if (els.routeMap.hidden || !window.L) return;
      if (routeLeaflet) {
        routeLeaflet.remove();
        routeLeaflet = null;
      }
      var map = L.map('mapCanvas');
      routeLeaflet = map;
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(map);
      var latlngs = points.map(function (point) { return [point.lat, point.lon]; });
      if (latlngs.length >= 2) {
        var line = L.polyline(latlngs, { color: cssColor('--accent', '#ff6d00'), weight: 5 }).addTo(map);
        map.fitBounds(line.getBounds(), { padding: [28, 28] });
      } else if (latlngs.length === 1) {
        map.setView(latlngs[0], 15);
      }
      if (latlngs.length) {
        L.circleMarker(latlngs[0], { radius: 7, color: cssColor('--text', '#ffb300'), fillColor: cssColor('--text', '#ffb300'), fillOpacity: 1 }).addTo(map);
        L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: cssColor('--accent', '#ff6d00'), fillColor: cssColor('--accent', '#ff6d00'), fillOpacity: 1 }).addTo(map);
      }
      setTimeout(function () { map.invalidateSize(); }, 80);
    }).catch(function () {
      els.mapNote.hidden = false;
      els.mapNote.textContent = 'Não foi possível abrir o mapa agora.';
    });
  }

  function cssColor(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function parseNum(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (value == null || String(value).trim() === '') return null;
    var number = parseFloat(String(value).replace(',', '.'));
    return isFinite(number) ? number : null;
  }

  function clampPeople(value) {
    var number = Math.round(parseNum(value) || 1);
    if (number < 1) return 1;
    if (number > 6) return 6;
    return number;
  }

  function blankVehicle() {
    return {
      catalogId: '',
      name: '',
      kind: 'carro',
      fuel: 'gasolina',
      kmPerLiter: '',
      tankLiters: '',
      litersNow: '',
      pricePerLiter: '',
      people: 1
    };
  }

  function formatBRL(cents) {
    return (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function formatPrice(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function formatLiters(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    }) + ' l';
  }

  function formatRemain(km) {
    if (km >= 1) return formatKm(km) + ' km';
    return Math.max(0, Math.round(km * 1000)) + ' m';
  }

  function computeCost(km, vehicle) {
    if (!vehicle) return null;
    var kmPerLiter = parseNum(vehicle.kmPerLiter);
    var price = parseNum(vehicle.pricePerLiter);
    var people = clampPeople(vehicle.people);
    if (!(kmPerLiter > 0) || price == null || price < 0 || !(km >= 0)) return null;
    var liters = km / kmPerLiter;
    var totalCents = Math.round(liters * price * 100);
    var base = Math.floor(totalCents / people);
    var remainder = totalCents - base * people;
    var shares = [];
    for (var i = 0; i < people; i++) shares.push(base + (i === 0 ? remainder : 0));
    return {
      liters: liters,
      totalCents: totalCents,
      people: people,
      sharesCents: shares,
      kmPerLiter: kmPerLiter,
      pricePerLiter: price
    };
  }

  function vehicleReady() {
    return !!computeCost(0, state.vehicle);
  }

  function costSnapshot(km) {
    var cost = computeCost(km, state.vehicle);
    if (!cost) return null;
    return {
      kmPerLiter: cost.kmPerLiter,
      pricePerLiter: cost.pricePerLiter,
      liters: cost.liters,
      totalCents: cost.totalCents,
      people: cost.people,
      sharesCents: cost.sharesCents,
      vehicleName: state.vehicle.name || '',
      kind: state.vehicle.kind || 'carro',
      fuel: state.vehicle.fuel || 'gasolina',
      tankLiters: parseNum(state.vehicle.tankLiters)
    };
  }

  function shareSuffix(cost) {
    if (!cost || cost.people < 2) return '';
    var same = cost.sharesCents.every(function (cents) { return cents === cost.sharesCents[0]; });
    if (same) return ' · ' + formatBRL(cost.sharesCents[0]) + ' cada';
    var low = cost.sharesCents[0];
    var high = low;
    cost.sharesCents.forEach(function (cents) {
      if (cents < low) low = cents;
      if (cents > high) high = cents;
    });
    return ' · ' + formatBRL(low) + ' a ' + formatBRL(high);
  }

  function tripCostText() {
    if (!vehicleReady()) return 'Defina o veículo';
    if (!state.trip) {
      return formatKm(parseNum(state.vehicle.kmPerLiter)) + ' km/l · ' + formatPrice(parseNum(state.vehicle.pricePerLiter)) + '/l';
    }
    var cost = computeCost(state.trip.distanceKm || 0, state.vehicle);
    return '≈ ' + formatBRL(cost.totalCents) + shareSuffix(cost);
  }

  function splitPhrase(cost) {
    var shares = cost.sharesCents || [];
    if ((cost.people || 1) < 2 || shares.length < 2) return 'Sem divisão';
    var same = shares.every(function (cents) { return cents === shares[0]; });
    if (same) return cost.people + ' pessoas · ' + formatBRL(shares[0]) + ' cada';
    return cost.people + ' pessoas · ' + shares.map(formatBRL).join(' · ') + '. A primeira cota fecha a conta.';
  }

  function spParts(ts) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(ts));
    var map = {};
    parts.forEach(function (part) { map[part.type] = part.value; });
    return map;
  }

  function spMidnight(ts) {
    var parts = spParts(ts);
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  }

  function weekStart(ts) {
    var midnight = spMidnight(ts);
    var day = new Date(midnight).getUTCDay();
    var delta = day === 0 ? 6 : day - 1;
    return midnight - delta * 86400000;
  }

  function periodStats(kind) {
    var now = Date.now();
    var km = 0;
    var cents = 0;
    state.history.forEach(function (trip) {
      var stamp = trip.startedAt;
      var same = kind === 'day'
        ? spMidnight(stamp) === spMidnight(now)
        : kind === 'week'
          ? weekStart(stamp) === weekStart(now)
          : spParts(stamp).year === spParts(now).year && spParts(stamp).month === spParts(now).month;
      if (!same) return;
      km += trip.distanceKm || 0;
      if (trip.cost) cents += trip.cost.totalCents || 0;
    });
    return { km: km, cents: cents };
  }

  function sumPeriod(kind) {
    var stats = periodStats(kind);
    return formatKm(stats.km) + ' km · ' + formatBRL(stats.cents);
  }

  function renderCostTotals() {
    var day = periodStats('day');
    var week = periodStats('week');
    var month = periodStats('month');
    if (els.periodDayKm) els.periodDayKm.textContent = formatKm(day.km) + ' km';
    if (els.periodDayCost) els.periodDayCost.textContent = formatBRL(day.cents);
    if (els.periodWeekKm) els.periodWeekKm.textContent = formatKm(week.km) + ' km';
    if (els.periodWeekCost) els.periodWeekCost.textContent = formatBRL(week.cents);
    if (els.periodMonthKm) els.periodMonthKm.textContent = formatKm(month.km) + ' km';
    if (els.periodMonthCost) els.periodMonthCost.textContent = formatBRL(month.cents);
  }

  function renderAreaStatus() {
    var count = state.history ? state.history.length : 0;
    var countLabel = count
      ? count + (count === 1 ? ' viagem' : ' viagens')
      : 'Nenhuma viagem';
    if (els.historyHint) els.historyHint.textContent = countLabel;
    if (els.areaHistory) els.areaHistory.textContent = countLabel;
    var vehicle = state.vehicle || {};
    if (els.areaVehicle) {
      var rate = parseNum(vehicle.kmPerLiter);
      els.areaVehicle.textContent = (vehicle.name || 'Sem nome') + (rate > 0 ? ' · ' + formatKm(rate) + ' km/l' : '');
    }
    if (els.areaRoute) {
      var dest = state.route && state.route.destination && state.route.destination.label;
      els.areaRoute.textContent = dest || 'Nenhuma rota armada';
    }
    if (els.areaTheme) {
      els.areaTheme.textContent = 'Tema ' + (THEMES[state.theme] ? THEMES[state.theme].label : 'Âmbar');
    }
  }

  function renderVehicleReadout() {
    if (!els.vehicleReadout) return;
    var vehicle = state.vehicle || blankVehicle();
    var kmPerLiter = parseNum(vehicle.kmPerLiter);
    var tank = parseNum(vehicle.tankLiters);
    var price = parseNum(vehicle.pricePerLiter);
    var nowLiters = parseNum(vehicle.litersNow);
    var bits = [];
    if (kmPerLiter > 0 && tank > 0) {
      bits.push('Tanque cheio ' + formatKm(tank * kmPerLiter) + ' km');
      if (price != null && price >= 0) bits.push(formatPrice(tank * price) + ' para encher');
    }
    if (kmPerLiter > 0 && vehicle.litersNow !== '' && nowLiters != null && nowLiters >= 0) {
      bits.push('Agora ' + formatKm(nowLiters * kmPerLiter) + ' km');
    }
    if (!bits.length) bits.push(vehicleReady() ? 'Pronto para calcular o trecho.' : 'Informe km/l e o preço do litro.');
    els.vehicleReadout.textContent = bits.join(' · ');
    renderAreaStatus();
  }

  function readVehicleForm() {
    var catalogId = els.vehicleCatalog.value;
    var kind = els.vehicleKind.value === 'moto' ? 'moto' : 'carro';
    if (catalogId !== '' && window.ROTA_CATALOG && window.ROTA_CATALOG[Number(catalogId)]) {
      kind = window.ROTA_CATALOG[Number(catalogId)].kind;
    }
    state.vehicle = {
      catalogId: catalogId,
      name: els.vehicleName.value.trim(),
      kind: kind,
      fuel: els.vehicleFuel.value || 'gasolina',
      kmPerLiter: els.vehicleKmL.value.trim(),
      tankLiters: els.vehicleTank.value.trim(),
      litersNow: els.vehicleNow.value.trim(),
      pricePerLiter: els.vehiclePrice.value.trim(),
      people: clampPeople(els.vehiclePeople.value)
    };
    if (els.vehicleKind.value !== state.vehicle.kind) els.vehicleKind.value = state.vehicle.kind;
    writeStore('rota.vehicle', state.vehicle);
    renderVehicleReadout();
    renderTrip();
    if (state.focus === MODE_NAV) renderNav();
  }

  function fillVehicleForm() {
    var vehicle = state.vehicle || blankVehicle();
    fillCatalog();
    els.vehicleCatalog.value = vehicle.catalogId || '';
    if (els.vehicleCatalog.value !== (vehicle.catalogId || '')) els.vehicleCatalog.value = '';
    els.vehicleName.value = vehicle.name || '';
    els.vehicleKind.value = vehicle.kind === 'moto' ? 'moto' : 'carro';
    els.vehicleFuel.value = vehicle.fuel || 'gasolina';
    els.vehicleKmL.value = vehicle.kmPerLiter == null ? '' : String(vehicle.kmPerLiter);
    els.vehicleTank.value = vehicle.tankLiters == null ? '' : String(vehicle.tankLiters);
    els.vehicleNow.value = vehicle.litersNow == null ? '' : String(vehicle.litersNow);
    els.vehiclePrice.value = vehicle.pricePerLiter == null ? '' : String(vehicle.pricePerLiter);
    els.vehiclePeople.value = String(clampPeople(vehicle.people));
    renderVehicleReadout();
  }

  function fillCatalog() {
    var select = els.vehicleCatalog;
    if (!select || select.options.length) return;
    var manual = document.createElement('option');
    manual.value = '';
    manual.textContent = 'Informar à mão';
    select.appendChild(manual);
    ['carro', 'moto'].forEach(function (kind) {
      var group = document.createElement('optgroup');
      group.label = kind === 'carro' ? 'Carros' : 'Motos';
      (window.ROTA_CATALOG || []).forEach(function (item, index) {
        if (item.kind !== kind) return;
        var option = document.createElement('option');
        option.value = String(index);
        option.textContent = item.name;
        group.appendChild(option);
      });
      select.appendChild(group);
    });
  }

  function applyCatalog(index) {
    var item = window.ROTA_CATALOG && window.ROTA_CATALOG[index];
    if (!item) return;
    els.vehicleName.value = item.name;
    els.vehicleKind.value = item.kind;
    els.vehicleFuel.value = item.fuel;
    els.vehicleKmL.value = String(item.kmPerLiter).replace('.', ',');
    els.vehicleTank.value = String(item.tankLiters).replace('.', ',');
  }

  function routeArmed() {
    return !!(state.route && state.route.geometry && state.route.geometry.length >= 2);
  }

  function projectRatio(lat, lon, a, b) {
    var lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
    var x = (lon - a.lon) * Math.cos(lat0);
    var y = lat - a.lat;
    var dx = (b.lon - a.lon) * Math.cos(lat0);
    var dy = b.lat - a.lat;
    var len2 = dx * dx + dy * dy;
    if (!len2) return 0;
    var t = (x * dx + y * dy) / len2;
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  }

  function routeProgress(lat, lon, line) {
    var best = { distKm: Infinity, alongKm: 0 };
    var along = 0;
    var total = 0;
    for (var i = 0; i < line.length - 1; i++) {
      var a = line[i];
      var b = line[i + 1];
      var segment = haversine(a.lat, a.lon, b.lat, b.lon);
      var t = projectRatio(lat, lon, a, b);
      var pointLat = a.lat + (b.lat - a.lat) * t;
      var pointLon = a.lon + (b.lon - a.lon) * t;
      var distance = haversine(lat, lon, pointLat, pointLon);
      if (distance < best.distKm) best = { distKm: distance, alongKm: along + segment * t };
      along += segment;
      total += segment;
    }
    best.totalKm = total;
    best.remainKm = Math.max(0, total - best.alongKm);
    best.off = best.distKm > OFF_ROUTE_KM;
    return best;
  }

  function stepText(step) {
    var maneuver = step.maneuver || {};
    var type = maneuver.type || '';
    var modifier = maneuver.modifier || '';
    var text = 'Siga';
    if (type === 'arrive') text = modifier === 'left' ? 'Chegada à esquerda' : modifier === 'right' ? 'Chegada à direita' : 'Chegada';
    else if (type === 'roundabout' || type === 'rotary') {
      text = 'Entre na rotatória';
      if (maneuver.exit) text += ', saída ' + maneuver.exit;
    } else if (type === 'exit roundabout' || type === 'exit rotary') {
      text = 'Saia da rotatória';
      if (maneuver.exit) text += ', saída ' + maneuver.exit;
    } else {
      var key = type + ':' + modifier;
      var table = {
        'turn:left': 'Vire à esquerda',
        'turn:right': 'Vire à direita',
        'turn:slight left': 'Mantenha-se à esquerda',
        'turn:slight right': 'Mantenha-se à direita',
        'turn:sharp left': 'Vire fechado à esquerda',
        'turn:sharp right': 'Vire fechado à direita',
        'turn:uturn': 'Retorne',
        'turn:straight': 'Siga em frente',
        'new name:straight': 'Siga em frente',
        'new name:slight left': 'Mantenha-se à esquerda',
        'new name:slight right': 'Mantenha-se à direita',
        'new name:left': 'Mantenha-se à esquerda',
        'new name:right': 'Mantenha-se à direita',
        'continue:straight': 'Siga em frente',
        'continue:slight left': 'Mantenha-se à esquerda',
        'continue:slight right': 'Mantenha-se à direita',
        'continue:left': 'Mantenha-se à esquerda',
        'continue:right': 'Mantenha-se à direita',
        'continue:uturn': 'Retorne',
        'depart:straight': 'Siga',
        'depart:left': 'Siga à esquerda',
        'depart:right': 'Siga à direita',
        'depart:slight left': 'Siga à esquerda',
        'depart:slight right': 'Siga à direita',
        'fork:left': 'Na bifurcação, à esquerda',
        'fork:right': 'Na bifurcação, à direita',
        'fork:slight left': 'Na bifurcação, à esquerda',
        'fork:slight right': 'Na bifurcação, à direita',
        'fork:straight': 'Siga na bifurcação',
        'merge:left': 'Entre à esquerda',
        'merge:right': 'Entre à direita',
        'merge:slight left': 'Entre à esquerda',
        'merge:slight right': 'Entre à direita',
        'merge:straight': 'Entre na via',
        'end of road:left': 'No fim da via, à esquerda',
        'end of road:right': 'No fim da via, à direita',
        'end of road:straight': 'No fim da via, siga em frente',
        'on ramp:left': 'Pegue a entrada à esquerda',
        'on ramp:right': 'Pegue a entrada à direita',
        'on ramp:slight left': 'Pegue a entrada à esquerda',
        'on ramp:slight right': 'Pegue a entrada à direita',
        'on ramp:straight': 'Pegue a entrada',
        'off ramp:left': 'Pegue a saída à esquerda',
        'off ramp:right': 'Pegue a saída à direita',
        'off ramp:slight left': 'Pegue a saída à esquerda',
        'off ramp:slight right': 'Pegue a saída à direita',
        'off ramp:straight': 'Pegue a saída'
      };
      text = table[key] || table[type + ':'] || 'Siga';
    }
    if (step.name && type !== 'arrive') text += ' · ' + step.name;
    return text;
  }

  function parseSteps(legs) {
    var steps = [];
    var along = 0;
    (legs || []).forEach(function (leg) {
      (leg.steps || []).forEach(function (step) {
        var location = step.maneuver && step.maneuver.location;
        if (!location) return;
        steps.push({
          lat: location[1],
          lon: location[0],
          alongKm: along,
          text: stepText(step)
        });
        along += (step.distance || 0) / 1000;
      });
    });
    return steps;
  }

  function simplifyLine(points, max) {
    if (points.length <= max) return points.slice();
    var out = [];
    var step = (points.length - 1) / (max - 1);
    for (var i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
    out[0] = points[0];
    out[out.length - 1] = points[points.length - 1];
    return out;
  }

  function buildRoute(osrmRoute, origin, destination) {
    var coords = (osrmRoute.geometry && osrmRoute.geometry.coordinates) || [];
    var geometry = simplifyLine(coords.map(function (pair) {
      return { lat: pair[1], lon: pair[0] };
    }), 150);
    return {
      origin: origin,
      destination: destination,
      distanceKm: (osrmRoute.distance || 0) / 1000,
      durationSec: osrmRoute.duration || 0,
      geometry: geometry,
      steps: parseSteps(osrmRoute.legs)
    };
  }

  function formatDuration(seconds) {
    var minutes = Math.max(0, Math.round(seconds / 60));
    if (minutes < 60) return minutes + ' min';
    return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
  }

  function routeSummaryText(route) {
    return formatKm(route.distanceKm) + ' km · ' + formatDuration(route.durationSec);
  }

  function placeLabel(props) {
    var main = props.name || [props.street, props.housenumber].filter(Boolean).join(', ') || 'Lugar';
    var city = props.city || props.town || props.village || props.county || '';
    var region = props.state || '';
    var tail = [city, region].filter(function (part, index, list) {
      return part && list.indexOf(part) === index;
    }).join(' · ');
    return tail ? main + ' · ' + tail : main;
  }

  function nextManeuver(alongKm) {
    var steps = (state.route && state.route.steps) || [];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].alongKm - alongKm >= 0.02) return steps[i];
    }
    return { text: 'Chegada', alongKm: alongKm };
  }

  function drawSketch(canvas, route, track, fix) {
    var rect = canvas.getBoundingClientRect();
    var width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 320));
    var height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 200));
    var ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = cssColor('--cutout', '#111111');
    ctx.fillRect(0, 0, width, height);
    var line = route || [];
    var driven = track || [];
    var cloud = line.concat(driven);
    if (fix) cloud.push({ lat: fix.lat, lon: fix.lon });
    if (line.length < 2) {
      ctx.fillStyle = cssColor('--muted', '#f0d48a');
      ctx.font = '700 14px Segoe UI, sans-serif';
      ctx.fillText('Escolha uma rota', 16, 28);
      return;
    }
    var minLat = Infinity;
    var maxLat = -Infinity;
    var minLon = Infinity;
    var maxLon = -Infinity;
    cloud.forEach(function (point) {
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lon < minLon) minLon = point.lon;
      if (point.lon > maxLon) maxLon = point.lon;
    });
    var spanLat = Math.max(0.002, maxLat - minLat);
    var spanLon = Math.max(0.002, maxLon - minLon);
    var pad = 18;
    function xy(point) {
      return [
        pad + ((point.lon - minLon) / spanLon) * (width - pad * 2),
        pad + ((maxLat - point.lat) / spanLat) * (height - pad * 2)
      ];
    }
    function stroke(points, color, widthPx) {
      if (!points || points.length < 2) return;
      ctx.beginPath();
      points.forEach(function (point, index) {
        var spot = xy(point);
        if (index === 0) ctx.moveTo(spot[0], spot[1]);
        else ctx.lineTo(spot[0], spot[1]);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = widthPx;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    stroke(line, cssColor('--accent', '#ff6d00'), 5);
    stroke(driven, cssColor('--text', '#ffb300'), 3);
    var start = xy(line[0]);
    var end = xy(line[line.length - 1]);
    ctx.fillStyle = cssColor('--text', '#ffb300');
    ctx.beginPath();
    ctx.arc(start[0], start[1], 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cssColor('--accent', '#ff6d00');
    ctx.beginPath();
    ctx.arc(end[0], end[1], 6, 0, Math.PI * 2);
    ctx.fill();
    if (fix) {
      var here = xy(fix);
      ctx.fillStyle = cssColor('--text', '#ffb300');
      ctx.beginPath();
      ctx.arc(here[0], here[1], 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = cssColor('--muted', '#f0d48a');
    ctx.font = '700 12px Segoe UI, sans-serif';
    ctx.fillText('Traçado salvo neste aparelho', 12, height - 10);
  }

  function showSketch(canvas, mapNode, route, track, fix) {
    if (mapNode) mapNode.hidden = true;
    canvas.hidden = false;
    requestAnimationFrame(function () { drawSketch(canvas, route, track, fix); });
  }

  function renderNav() {
    if (state.focus !== MODE_NAV || !els.navManeuver) return;
    var route = state.route;
    if (els.navPick) els.navPick.hidden = routeArmed();
    if (els.navSwap) els.navSwap.hidden = !routeArmed();
    if (!routeArmed()) {
      els.navManeuver.textContent = 'Mapa ao lado do velocímetro';
      els.navRemain.textContent = 'Escolha a partida e o destino. O traçado fica neste aparelho.';
      els.navCost.textContent = tripCostText();
      if (els.navCredit) els.navCredit.textContent = navigator.onLine ? '© OpenStreetMap' : 'Sem rede para o mapa-base';
      if (!navigator.onLine || !mapCenter()) showSketch(els.navSketch, els.navMap, [], state.trip && state.trip.track, lastFix);
      return;
    }
    var progress = lastFix ? routeProgress(lastFix.lat, lastFix.lon, route.geometry) : null;
    var off = !!(progress && progress.off);
    if (!lastFix) {
      els.navManeuver.textContent = route.steps && route.steps[0] ? route.steps[0].text : 'Rota pronta';
      els.navRemain.textContent = 'Previsto ' + routeSummaryText(route);
    } else if (off) {
      els.navManeuver.textContent = 'Fora do traçado';
      els.navRemain.textContent = 'O custo segue o km medido';
    } else {
      var step = nextManeuver(progress.alongKm);
      var ahead = Math.max(0, step.alongKm - progress.alongKm);
      els.navManeuver.textContent = step.text;
      var remain = 'em ' + formatRemain(ahead) + ' · restam ' + formatRemain(progress.remainKm);
      var speed = state.displayKmh;
      var hours = speed >= 8
        ? progress.remainKm / speed
        : (route.durationSec / 3600) * (route.distanceKm ? progress.remainKm / route.distanceKm : 0);
      if (hours > 0 && isFinite(hours)) {
        remain += ' · ' + new Date(Date.now() + hours * 3600000).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        });
      }
      els.navRemain.textContent = remain;
    }
    var measured = state.trip ? state.trip.distanceKm || 0 : 0;
    var spent = state.trip ? computeCost(measured, state.vehicle) : null;
    var line = state.trip
      ? (spent ? 'Até agora ' + formatBRL(spent.totalCents) + shareSuffix(spent) : 'Defina o veículo')
      : (vehicleReady() ? '' : 'Defina o veículo');
    if (!off && vehicleReady()) {
      var planned = computeCost(route.distanceKm, state.vehicle);
      if (planned) line += (line ? ' · previsto ' : 'Previsto ') + formatBRL(planned.totalCents);
    }
    if (!line) line = tripCostText();
    els.navCost.textContent = line;
    if (els.navCredit) {
      els.navCredit.textContent = navigator.onLine ? '© OpenStreetMap' : 'Traçado salvo neste aparelho';
    }
    if (!navigator.onLine || els.navMap.hidden) {
      showSketch(els.navSketch, els.navMap, route.geometry, state.trip && state.trip.track, lastFix);
      return;
    }
    updateNavLayers();
  }

  function mapCenter() {
    if (lastFix) return [lastFix.lat, lastFix.lon];
    if (state.weather && state.weather.lat != null && state.weather.lon != null) {
      return [state.weather.lat, state.weather.lon];
    }
    return null;
  }

  function ensureNav() {
    renderNav();
    if (!navigator.onLine || (!routeArmed() && !mapCenter())) {
      showSketch(els.navSketch, els.navMap, state.route && state.route.geometry, [], lastFix);
      return;
    }
    els.navSketch.hidden = true;
    els.navMap.hidden = false;
    loadLeaflet().then(function () {
      if (state.focus !== MODE_NAV || !window.L) return;
      if (!navLeaflet) {
        navLeaflet = L.map('navMap', { zoomControl: false, attributionControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap'
        }).addTo(navLeaflet);
        navRouteLine = L.polyline([], { weight: 5 }).addTo(navLeaflet);
        navTrackLine = L.polyline([], { weight: 4 }).addTo(navLeaflet);
        navMarker = L.circleMarker([0, 0], { radius: 7, fillOpacity: 1 }).addTo(navLeaflet);
      }
      updateNavLayers();
      setTimeout(function () { if (navLeaflet) navLeaflet.invalidateSize(); }, 80);
    }).catch(function () {
      showSketch(els.navSketch, els.navMap, state.route && state.route.geometry, state.trip && state.trip.track, lastFix);
    });
  }

  function updateNavLayers() {
    if (!navLeaflet) return;
    if (!routeArmed()) {
      navRouteLine.setLatLngs([]);
      navTrackLine.setLatLngs([]);
      var center = mapCenter();
      if (!center) return;
      navMarker.setLatLng(center);
      navMarker.setStyle({ color: cssColor('--accent', '#ff6d00'), fillColor: cssColor('--accent', '#ff6d00') });
      if (!navFitted) {
        navLeaflet.setView(center, 14);
        navFitted = true;
      }
      return;
    }
    var accent = cssColor('--accent', '#ff6d00');
    var text = cssColor('--text', '#ffb300');
    navRouteLine.setLatLngs(state.route.geometry.map(function (point) { return [point.lat, point.lon]; }));
    navRouteLine.setStyle({ color: accent });
    var track = (state.trip && state.trip.track) || [];
    navTrackLine.setLatLngs(track.map(function (point) { return [point.lat, point.lon]; }));
    navTrackLine.setStyle({ color: text });
    if (lastFix) {
      navMarker.setLatLng([lastFix.lat, lastFix.lon]);
      navMarker.setStyle({ color: text, fillColor: text });
    }
    if (!navFitted) {
      navLeaflet.fitBounds(navRouteLine.getBounds(), { padding: [24, 24] });
      navFitted = true;
    }
  }

  function scheduleSearch(target) {
    clearTimeout(state.searchTimer);
    var input = target === 'origin' ? els.originInput : els.destInput;
    var query = input.value.trim();
    if (query.length < 3) {
      els.placeResults.replaceChildren();
      return;
    }
    state.searchTimer = setTimeout(function () { runSearch(query, target); }, 400);
  }

  function searchBias() {
    if (lastFix) return { lat: lastFix.lat, lon: lastFix.lon };
    if (state.weather && state.weather.lat != null && state.weather.lon != null) {
      return { lat: state.weather.lat, lon: state.weather.lon };
    }
    return null;
  }

  function runSearch(query, target) {
    var url = 'https://photon.komoot.io/api/?limit=5&q=' + encodeURIComponent(query);
    var bias = searchBias();
    if (bias) url += '&lat=' + bias.lat + '&lon=' + bias.lon;
    fetch(url).then(function (response) {
      if (!response.ok) throw new Error('busca');
      return response.json();
    }).then(function (data) {
      var features = (data.features || []).slice(0, 5);
      if (!features.length) {
        els.placeResults.replaceChildren();
        els.plannerNote.textContent = 'Nenhum lugar encontrado.';
        return;
      }
      els.plannerNote.textContent = 'A busca pede internet uma vez. O traçado fica neste aparelho.';
      renderPlaces(features, target);
    }).catch(function () {
      els.placeResults.replaceChildren();
      els.plannerNote.textContent = 'Não foi possível buscar agora.';
    });
  }

  function renderPlaces(features, target) {
    els.placeResults.replaceChildren();
    features.forEach(function (feature) {
      var coords = feature.geometry && feature.geometry.coordinates;
      if (!coords) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'skeuo';
      button.textContent = placeLabel(feature.properties || {});
      button.addEventListener('click', function () {
        var place = { lat: coords[1], lon: coords[0], label: button.textContent };
        if (target === 'origin') {
          state.draft.origin = place;
          els.originInput.value = place.label;
        } else {
          state.draft.destination = place;
          els.destInput.value = place.label;
        }
        els.placeResults.replaceChildren();
        fetchDraftRoute();
        tap();
      });
      els.placeResults.appendChild(button);
    });
  }

  function fetchDraftRoute() {
    var origin = state.draft.origin;
    var destination = state.draft.destination;
    if (!origin || !destination) return;
    if (!navigator.onLine) {
      els.routeSummary.textContent = 'A busca da rota precisa de internet.';
      els.useRoute.disabled = true;
      return;
    }
    var token = ++routeToken;
    els.routeSummary.textContent = 'Traçando…';
    els.useRoute.disabled = true;
    var url = 'https://router.project-osrm.org/route/v1/driving/' +
      origin.lon + ',' + origin.lat + ';' + destination.lon + ',' + destination.lat +
      '?overview=full&geometries=geojson&steps=true';
    fetch(url).then(function (response) {
      if (!response.ok) throw new Error('rota');
      return response.json();
    }).then(function (data) {
      if (token !== routeToken) return;
      if (!data.routes || !data.routes[0]) throw new Error('rota');
      state.draft.route = buildRoute(data.routes[0], origin, destination);
      els.useRoute.disabled = false;
      els.routeSummary.textContent = routeSummaryText(state.draft.route);
      els.plannerNote.textContent = 'A busca pede internet uma vez. O traçado fica neste aparelho.';
      showPlannerMap(state.draft.route);
    }).catch(function () {
      if (token !== routeToken) return;
      state.draft.route = null;
      els.useRoute.disabled = true;
      els.routeSummary.textContent = 'Não foi possível traçar a rota agora.';
    });
  }

  function showPlannerMap(route) {
    if (!route || !route.geometry) return;
    if (!navigator.onLine) {
      showSketch(els.plannerSketch, els.plannerMap, route.geometry, [], null);
      return;
    }
    els.plannerSketch.hidden = true;
    els.plannerMap.hidden = false;
    loadLeaflet().then(function () {
      if (els.routePlanner.hidden || !window.L) return;
      if (!plannerLeaflet) {
        plannerLeaflet = L.map('plannerMap', { zoomControl: false, attributionControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap'
        }).addTo(plannerLeaflet);
        plannerLine = L.polyline([], { weight: 5 }).addTo(plannerLeaflet);
      }
      var latlngs = route.geometry.map(function (point) { return [point.lat, point.lon]; });
      plannerLine.setLatLngs(latlngs);
      plannerLine.setStyle({ color: cssColor('--accent', '#ff6d00') });
      if (latlngs.length >= 2) plannerLeaflet.fitBounds(plannerLine.getBounds(), { padding: [20, 20] });
      setTimeout(function () { if (plannerLeaflet) plannerLeaflet.invalidateSize(); }, 80);
    }).catch(function () {
      showSketch(els.plannerSketch, els.plannerMap, route.geometry, [], null);
    });
  }

  function openPlanner() {
    state.draft = {
      origin: state.route ? state.route.origin : null,
      destination: state.route ? state.route.destination : null,
      route: state.route || null
    };
    els.originInput.value = state.draft.origin ? state.draft.origin.label : '';
    els.destInput.value = state.draft.destination ? state.draft.destination.label : '';
    els.placeResults.replaceChildren();
    els.useRoute.disabled = !state.draft.route;
    els.routeSummary.textContent = state.draft.route ? routeSummaryText(state.draft.route) : '';
    els.plannerNote.textContent = 'A busca pede internet uma vez. O traçado fica neste aparelho.';
    if (screenStack[screenStack.length - 1] !== 'route') screenStack.push('route');
    presentTop();
    if (state.draft.route) showPlannerMap(state.draft.route);
    tap();
  }

  function closePlanner() {
    backScreen();
  }

  function useArmedRoute() {
    if (!state.draft.route) return;
    state.route = state.draft.route;
    writeStore('rota.route', state.route);
    closeAllScreens();
    setFocus(MODE_NAV);
    renderAreaStatus();
  }

  function clearArmedRoute() {
    state.route = null;
    state.draft.route = null;
    writeStore('rota.route', null);
    els.useRoute.disabled = true;
    els.routeSummary.textContent = '';
    if (state.focus === MODE_NAV) setFocus(0);
    renderAreaStatus();
    tap();
  }

  function openGoogleDirections() {
    var destination = state.draft.destination || (state.route && state.route.destination);
    var origin = state.draft.origin || (state.route && state.route.origin);
    var web = 'https://www.google.com/maps/dir/?api=1&travelmode=driving';
    if (origin) web += '&origin=' + origin.lat + ',' + origin.lon;
    if (destination) web += '&destination=' + destination.lat + ',' + destination.lon;
    else web = 'https://maps.google.com/maps';
    var android = /Android/i.test(navigator.userAgent || '');
    tap();
    if (android) {
      var host = web.replace(/^https?:\/\//, '');
      location.href = 'intent://' + host + '#Intent;scheme=https;package=com.google.android.apps.maps;S.browser_fallback_url=' + encodeURIComponent(web) + ';end';
      return;
    }
    location.href = web;
  }

  function useMyPosition() {
    if (!lastFix) {
      els.plannerNote.textContent = 'Aguardando GPS. Busque a partida pelo endereço.';
      return;
    }
    state.draft.origin = { lat: lastFix.lat, lon: lastFix.lon, label: 'Minha posição' };
    els.originInput.value = 'Minha posição';
    els.placeResults.replaceChildren();
    fetchDraftRoute();
    tap();
  }

  function receiptModel(trip) {
    var km = trip.distanceKm || 0;
    var hours = (trip.movingMs || 0) / 3600000;
    var track = trip.track && trip.track.length >= 2 ? trip.track : (trip.plannedGeometry || []);
    var usingPlan = !(trip.track && trip.track.length >= 2) && track.length >= 2;
    var model = {
      km: formatKm(km) + ' km',
      when: formatWhen(trip.startedAt) + (trip.endedAt ? ' → ' + formatClock(trip.endedAt) : ''),
      meta: (trip.movingMs ? formatSpan(trip.movingMs) + ' · ' : '') + (hours > 0 ? Math.round(km / hours) + ' km/h méd' : '— km/h méd'),
      track: track,
      places: (trip.origin || trip.destination) ? (trip.origin || 'Partida') + ' → ' + (trip.destination || 'Destino') : '',
      footer: 'Estimativa. Não é cupom fiscal. Traçado do GPS, sem mapa-base.'
    };
    if (trip.plannedKm) model.planned = 'Previsto na rota ' + formatKm(trip.plannedKm) + ' km. Vale o km medido.';
    if (usingPlan) model.extra = 'Traçado previsto, sem GPS suficiente.';
    if (trip.simulated) model.extra = 'Simulação. Não é um percurso real.';
    if (!trip.cost) {
      model.vehicle = 'Sem custo neste trecho.';
      return model;
    }
    var fuel = { gasolina: 'gasolina', etanol: 'etanol', diesel: 'diesel' }[trip.cost.fuel] || '';
    model.vehicle = [trip.cost.vehicleName || 'Veículo', fuel].filter(Boolean).join(' · ');
    model.formula = formatKm(km) + ' km ÷ ' + formatKm(trip.cost.kmPerLiter) + ' km/l × ' + formatPrice(trip.cost.pricePerLiter) + ' = ' + formatBRL(trip.cost.totalCents);
    model.liters = formatLiters(trip.cost.liters);
    model.split = splitPhrase(trip.cost);
    return model;
  }

  function openReceipt(trip) {
    if (!window.RotaReceipt) return;
    state.receiptCanvas = window.RotaReceipt.draw(receiptModel(trip));
    els.receiptImg.src = state.receiptCanvas.toDataURL('image/png');
    els.receiptSheet.hidden = false;
  }

  function closeReceipt() {
    els.receiptSheet.hidden = true;
  }

  function init() {
    els.kmh = $('kmh');
    els.mph = $('mph');
    els.gpsPill = $('gpsPill');
    els.clock = $('clock');
    els.batteryText = $('batteryText');
    els.batIcon = $('batIcon');
    els.weatherIcon = $('weatherIcon');
    els.weatherTemp = $('weatherTemp');
    els.weatherDesc = $('weatherDesc');
    els.hours = $('hours');
    els.tripState = $('tripState');
    els.tripKm = $('tripKm');
    els.tripTime = $('tripTime');
    els.tripAvg = $('tripAvg');
    els.pauseLabel = $('pauseLabel');
    els.startTrip = $('startTrip');
    els.pauseTrip = $('pauseTrip');
    els.finishTrip = $('finishTrip');
    els.gauge = $('gauge');
    els.hudHint = document.querySelector('.hud-hint');
    els.companion = $('companion');
    els.clockDigital = $('clockDigital');
    els.toolPicker = $('toolPicker');
    els.toolFace = $('toolFace');
    els.toolName = $('toolName');
    els.toolReadout = $('toolReadout');
    els.toolActions = $('toolActions');
    els.routeMap = $('routeMap');
    els.mapMeta = $('mapMeta');
    els.mapNote = $('mapNote');
    els.themeChip = $('themeChip');
    els.deck = $('deck');
    els.historyList = $('historyList');
    els.historySummary = $('historySummary');
    els.historyHint = $('historyHint');
    els.areaHistory = $('areaHistory');
    els.areaVehicle = $('areaVehicle');
    els.areaRoute = $('areaRoute');
    els.areaTheme = $('areaTheme');
    els.periodDayKm = $('periodDayKm');
    els.periodDayCost = $('periodDayCost');
    els.periodWeekKm = $('periodWeekKm');
    els.periodWeekCost = $('periodWeekCost');
    els.periodMonthKm = $('periodMonthKm');
    els.periodMonthCost = $('periodMonthCost');
    els.demoSwitch = $('demoSwitch');
    els.installBtn = $('installBtn');
    els.tripCost = $('tripCost');
    els.navPane = $('navPane');
    els.navMap = $('navMap');
    els.navSketch = $('navSketch');
    els.navManeuver = $('navManeuver');
    els.navRemain = $('navRemain');
    els.navCost = $('navCost');
    els.navCredit = $('navCredit');
    els.navPick = $('navPick');
    els.navSwap = $('navSwap');
    els.navStart = $('navStart');
    els.navPause = $('navPause');
    els.navFinish = $('navFinish');
    els.navPauseLabel = $('navPauseLabel');
    els.vehicleCatalog = $('vehicleCatalog');
    els.vehicleName = $('vehicleName');
    els.vehicleKind = $('vehicleKind');
    els.vehicleFuel = $('vehicleFuel');
    els.vehiclePeople = $('vehiclePeople');
    els.vehicleKmL = $('vehicleKmL');
    els.vehicleTank = $('vehicleTank');
    els.vehiclePrice = $('vehiclePrice');
    els.vehicleNow = $('vehicleNow');
    els.vehicleReadout = $('vehicleReadout');
    els.vehicleBlock = $('vehicleBlock');
    els.routePlanner = $('routePlanner');
    els.plannerNote = $('plannerNote');
    els.originInput = $('originInput');
    els.destInput = $('destInput');
    els.placeResults = $('placeResults');
    els.routeSummary = $('routeSummary');
    els.useRoute = $('useRoute');
    els.plannerMap = $('plannerMap');
    els.plannerSketch = $('plannerSketch');
    els.receiptSheet = $('receiptSheet');
    els.receiptImg = $('receiptImg');

    state.history = readStore('rota.history', []) || [];
    state.vehicle = Object.assign(blankVehicle(), readStore('rota.vehicle', {}) || {});
    state.route = readStore('rota.route', null);
    state.trip = readStore('rota.trip', null);
    state.weather = readStore('rota.weather', null);
    state.demo = !!readStore('rota.demo', false);
    state.instrument = readStore('rota.instrument', '') || '';
    var storedAlarm = readStore('rota.alarm', null);
    if (storedAlarm) state.alarm = storedAlarm;
    var storedTheme = readStore('rota.theme', document.documentElement.dataset.theme || 'amber');

    buildDial();
    buildClock();
    applyTheme(storedTheme);
    fillVehicleForm();
    renderSpeed();
    renderClock();
    renderTrip();
    renderHistory();
    renderWeather();
    setInstrument(state.instrument);
    setInterval(function () {
      renderClock();
      if (state.trip) renderTrip();
      if (state.focus === MODE_NAV) renderNav();
    }, 1000);

    els.gauge.addEventListener('click', function (event) {
      event.stopPropagation();
      setFocus(state.focus + 1);
    });
    $('dashboard').addEventListener('click', function (event) {
      if (!state.focus) return;
      if (event.target.closest('#gauge') || event.target.closest('#companion') || event.target.closest('#navPane')) return;
      setFocus(0);
    });
    $('clockDial').addEventListener('click', function (event) {
      event.stopPropagation();
      els.toolPicker.hidden = !els.toolPicker.hidden;
    });
    document.querySelectorAll('#toolPicker button').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        setInstrument(button.getAttribute('data-tool') || '');
      });
    });
    $('closeMap').addEventListener('click', closeRoute);
    $('startTrip').addEventListener('click', startTrip);
    $('pauseTrip').addEventListener('click', pauseTrip);
    $('finishTrip').addEventListener('click', finishTrip);
    $('openMaps').addEventListener('click', function () { setFocus(MODE_NAV); tap(); });
    $('navPick').addEventListener('click', openPlanner);
    $('navSwap').addEventListener('click', openPlanner);
    $('useHere').addEventListener('click', useMyPosition);
    $('useRoute').addEventListener('click', useArmedRoute);
    $('clearRoute').addEventListener('click', clearArmedRoute);
    $('openGoogle').addEventListener('click', openGoogleDirections);
    $('originInput').addEventListener('input', function () {
      state.draft.origin = null;
      state.draft.route = null;
      els.useRoute.disabled = true;
      scheduleSearch('origin');
    });
    $('destInput').addEventListener('input', function () {
      state.draft.destination = null;
      state.draft.route = null;
      els.useRoute.disabled = true;
      scheduleSearch('dest');
    });
    $('navStart').addEventListener('click', startTrip);
    $('navPause').addEventListener('click', pauseTrip);
    $('navFinish').addEventListener('click', finishTrip);
    $('tripCost').addEventListener('click', function () { openRoot('screenVehicle'); });
    $('closeReceipt').addEventListener('click', closeReceipt);
    $('shareReceipt').addEventListener('click', function () {
      if (state.receiptCanvas && window.RotaReceipt) window.RotaReceipt.share(state.receiptCanvas);
    });
    $('pdfReceipt').addEventListener('click', function () {
      if (state.receiptCanvas && window.RotaReceipt) window.RotaReceipt.printPdf(state.receiptCanvas);
    });
    els.vehicleCatalog.addEventListener('change', function () {
      if (els.vehicleCatalog.value !== '') applyCatalog(Number(els.vehicleCatalog.value));
      readVehicleForm();
    });
    ['vehicleName', 'vehicleKind', 'vehicleFuel', 'vehiclePeople', 'vehicleKmL', 'vehicleTank', 'vehiclePrice', 'vehicleNow'].forEach(function (id) {
      $(id).addEventListener('input', readVehicleForm);
      $(id).addEventListener('change', readVehicleForm);
    });
    $('openSpotify').addEventListener('click', function () { openExternal('spotify'); });
    $('openHistory').addEventListener('click', function () { openRoot('screenAreas'); });
    $('themeChip').addEventListener('click', function () { openRoot('screenSettings'); });
    document.querySelectorAll('.screen-back').forEach(function (button) {
      button.addEventListener('click', backScreen);
    });
    document.querySelectorAll('[data-open]').forEach(function (button) {
      button.addEventListener('click', function () {
        var target = button.getAttribute('data-open');
        if (target === 'route') openPlanner();
        else openScreen(target);
      });
    });
    $('demoSwitch').addEventListener('click', function () { setDemo(!state.demo); tap(); });
    document.querySelectorAll('[data-theme-choice]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        applyTheme(chip.getAttribute('data-theme-choice'));
        tap();
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if ((els.receiptSheet && !els.receiptSheet.hidden) || (els.routeMap && !els.routeMap.hidden) || screenStack.length) {
        backScreen();
        return;
      }
      if (state.focus) setFocus(0);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') requestWake();
    });

    window.addEventListener('resize', function () {
      if (navLeaflet) navLeaflet.invalidateSize();
      if (plannerLeaflet) plannerLeaflet.invalidateSize();
      if (state.focus === MODE_NAV && !navigator.onLine) {
        drawSketch(els.navSketch, state.route && state.route.geometry, state.trip && state.trip.track, lastFix);
      }
    });
    window.addEventListener('online', function () { if (state.focus === MODE_NAV) ensureNav(); });
    window.addEventListener('offline', function () { if (state.focus === MODE_NAV) renderNav(); });

    bindBattery();
    bindInstall();
    requestWake();
    cacheShell();
    if (state.demo) setDemo(true);
    else startGps();
  }

  cacheShell();
  document.addEventListener('pointerdown', enterImmersive, true);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') enterImmersive();
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
