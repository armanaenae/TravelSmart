/* =============================================================
 * Weather — Open-Meteo (free, no key required)
 * https://open-meteo.com/
 * ============================================================= */

const WEATHER_ICONS = {
  0: '☀️',  // Clear sky
  1: '🌤️', 2: '⛅', 3: '☁️',  // Partly cloudy / overcast
  45: '🌫️', 48: '🌫️',  // Fog
  51: '🌦️', 53: '🌦️', 55: '🌦️',  // Drizzle
  61: '🌧️', 63: '🌧️', 65: '🌧️',  // Rain
  71: '🌨️', 73: '🌨️', 75: '❄️',  // Snow
  80: '🌦️', 81: '🌧️', 82: '⛈️',  // Rain showers
  95: '⛈️', 96: '⛈️', 99: '⛈️',  // Thunderstorm
};

function weatherIcon(code) {
  return WEATHER_ICONS[code] || '·';
}

/**
 * Fetch daily forecast starting from startDate (YYYY-MM-DD) for N days.
 * Open-Meteo forecast is limited to ~16 days; we clamp to that.
 */
async function fetchForecast(lat, lng, startDate, days) {
  if (lat == null || lng == null || !startDate || !days) return null;

  // Clamp: Open-Meteo only supports forecast up to ~16 days ahead
  const start = new Date(startDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysFromToday = Math.floor((start - today) / (86400000));

  // If trip is entirely in the past, or too far in the future, skip
  if (daysFromToday > 15) return { unavailable: true, reason: 'too-far' };
  if (daysFromToday + days < -30) return { unavailable: true, reason: 'past' };

  const requestDays = Math.min(days, 16);
  const end = new Date(start);
  end.setDate(end.getDate() + requestDays - 1);

  const fmt = (d) => d.toISOString().slice(0, 10);

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', fmt(start));
  url.searchParams.set('end_date', fmt(end));

  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error('Weather API ' + res.status);
    const data = await res.json();
    if (!data.daily || !data.daily.time) return null;

    return {
      unavailable: false,
      days: data.daily.time.map((date, i) => ({
        date,
        code: data.daily.weather_code[i],
        tmax: Math.round(data.daily.temperature_2m_max[i]),
        tmin: Math.round(data.daily.temperature_2m_min[i]),
        rain: data.daily.precipitation_probability_max[i],
      })),
    };
  } catch (err) {
    console.warn('Weather fetch failed:', err);
    return null;
  }
}

function renderWeatherStrip(container, forecast, startDate) {
  if (!forecast || forecast.unavailable || !forecast.days || !forecast.days.length) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const startD = new Date(startDate + 'T00:00:00');

  const html = forecast.days.slice(0, 7).map((d, i) => {
    const dt = new Date(startD);
    dt.setDate(dt.getDate() + i);
    const label = dt.toLocaleDateString(undefined, { weekday: 'short' });
    const dateN = dt.getDate();
    return `
      <div class="weather-day" title="Day ${i + 1}">
        <div class="wd-label">${label} ${dateN}</div>
        <div class="wd-icon" aria-hidden="true">${weatherIcon(d.code)}</div>
        <div class="wd-temp">${d.tmax}° <span class="lo">${d.tmin}°</span></div>
      </div>`;
  }).join('');

  container.innerHTML = html;
}

window.Weather = { fetchForecast, renderWeatherStrip, weatherIcon };
