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
  var ARC_START = -120;
  var ARC_SWEEP = 240;
  var STOP_KMH = 1.5;
  var KMH_TO_MPH = 0.621371;
  var WEATHER_MAX_AGE = 20 * 60 * 1000;
  var WEATHER_MOVE_KM = 8;

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
    installPrompt: null
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
      els.pauseLabel.textContent = 'Pausar';
      els.startTrip.disabled = false;
      els.pauseTrip.disabled = true;
      els.finishTrip.disabled = true;
      els.pauseTrip.classList.remove('is-live');
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
    els.pauseLabel.textContent = trip.paused ? 'Retomar' : 'Pausar';
    els.startTrip.disabled = true;
    els.pauseTrip.disabled = false;
    els.finishTrip.disabled = false;
    els.pauseTrip.classList.toggle('is-live', !trip.paused);
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
    state.history.unshift({
      id: state.trip.id,
      startedAt: state.trip.startedAt,
      endedAt: now,
      distanceKm: state.trip.distanceKm || 0,
      movingMs: movingMs(state.trip, now),
      start: state.trip.start || null,
      end: state.trip.end || null,
      track: state.trip.track || [],
      simulated: !!state.trip.simulated
    });
    if (state.history.length > 30) state.history.length = 30;
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
  }

  function setFocus(mode) {
    state.focus = mode;
    state.hud = mode === 2;
    document.body.classList.toggle('is-focus', mode === 1);
    document.body.classList.toggle('is-hud', mode === 2);
    if (els.companion) els.companion.hidden = mode !== 1;
    if (els.toolPicker && mode !== 1) els.toolPicker.hidden = true;
    els.gauge.setAttribute('aria-pressed', mode ? 'true' : 'false');
    if (els.hudHint) {
      els.hudHint.textContent = mode === 1 ? 'Toque para o velocímetro' : 'Toque para voltar';
    }
    if (mode === 1) renderClock();
  }

  function openDrawer() {
    els.scrim.hidden = false;
    els.drawer.hidden = false;
    document.body.style.overflow = 'hidden';
    renderHistory();
  }

  function closeDrawer() {
    els.scrim.hidden = true;
    els.drawer.hidden = true;
    document.body.style.overflow = '';
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
    els.historyHint.textContent = state.history.length
      ? state.history.length + (state.history.length === 1 ? ' viagem' : ' viagens')
      : 'Nenhuma';

    if (!state.history.length) return;

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
      var route = trip.track && trip.track.length >= 2;
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
    els.toolFace.hidden = state.focus !== 1;
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

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
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
        var line = L.polyline(latlngs, { color: '#ff6d00', weight: 5 }).addTo(map);
        map.fitBounds(line.getBounds(), { padding: [28, 28] });
      } else if (latlngs.length === 1) {
        map.setView(latlngs[0], 15);
      }
      if (latlngs.length) {
        L.circleMarker(latlngs[0], { radius: 7, color: '#ffb300', fillColor: '#ffb300', fillOpacity: 1 }).addTo(map);
        L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: '#ff6d00', fillColor: '#ff6d00', fillOpacity: 1 }).addTo(map);
      }
      setTimeout(function () { map.invalidateSize(); }, 80);
    }).catch(function () {
      els.mapNote.hidden = false;
      els.mapNote.textContent = 'Não foi possível abrir o mapa agora.';
    });
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
    els.scrim = $('scrim');
    els.drawer = $('drawer');
    els.historyList = $('historyList');
    els.historySummary = $('historySummary');
    els.historyHint = $('historyHint');
    els.demoSwitch = $('demoSwitch');
    els.installBtn = $('installBtn');

    state.history = readStore('rota.history', []) || [];
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
    renderSpeed();
    renderClock();
    renderTrip();
    renderHistory();
    renderWeather();
    setInstrument(state.instrument);
    setInterval(function () {
      renderClock();
      if (state.trip) renderTrip();
    }, 1000);

    els.gauge.addEventListener('click', function (event) {
      event.stopPropagation();
      setFocus((state.focus + 1) % 3);
    });
    $('dashboard').addEventListener('click', function (event) {
      if (!state.focus) return;
      if (event.target.closest('#gauge') || event.target.closest('#companion')) return;
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
    $('openMaps').addEventListener('click', function () { openExternal('maps'); });
    $('openSpotify').addEventListener('click', function () { openExternal('spotify'); });
    $('openHistory').addEventListener('click', openDrawer);
    $('themeChip').addEventListener('click', openDrawer);
    $('closeDrawer').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('demoSwitch').addEventListener('click', function () { setDemo(!state.demo); tap(); });
    document.querySelectorAll('[data-theme-choice]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        applyTheme(chip.getAttribute('data-theme-choice'));
        tap();
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!els.drawer.hidden) closeDrawer();
      else if (els.routeMap && !els.routeMap.hidden) closeRoute();
      else if (state.focus) setFocus(0);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') requestWake();
    });

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
