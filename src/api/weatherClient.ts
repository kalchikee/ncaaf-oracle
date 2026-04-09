// NCAAF Oracle v4.1 — Open-Meteo Weather Client
// Free, no API key needed. https://open-meteo.com/
// Fetches game-time temperature, wind, and precipitation for outdoor venues.

import fetch from 'node-fetch';
import { logger } from '../logger.js';
import type { WeatherData } from '../types.js';

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

// ─── Indoor / domed stadiums ───────────────────────────────────────────────────

const DOME_TEAMS = new Set([
  'georgia dome', 'mercedes-benz stadium', 'at&t stadium', 'dallas',
  'nrg stadium', 'houston', 'lucas oil stadium', 'indianapolis',
  'u.s. bank stadium', 'minnesota', 'caesars superdome', 'new orleans', 'tulane',
  'allegiant stadium', 'las vegas', 'unlv',
  'ford field', 'detroit', 'michigan state', // close enough
  'state farm stadium', 'arizona', 'arizona state',
  'sofi stadium', 'usc', 'ucla',
]);

export function isIndoorVenue(homeTeam: string): boolean {
  return DOME_TEAMS.has(homeTeam.toLowerCase());
}

// ─── Fetch weather for a game ──────────────────────────────────────────────────

export async function fetchGameWeather(
  lat: number,
  lon: number,
  gameDate: string,  // YYYY-MM-DD
  gameHour = 15,     // 3 PM local as default kickoff
): Promise<WeatherData> {
  try {
    const url = new URL(OPEN_METEO_BASE);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('hourly', 'temperature_2m,wind_speed_10m,precipitation,weather_code');
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('wind_speed_unit', 'mph');
    url.searchParams.set('start_date', gameDate);
    url.searchParams.set('end_date', gameDate);
    url.searchParams.set('timezone', 'America/Chicago'); // central time as approximation

    const res = await fetch(url.toString());
    if (!res.ok) {
      logger.warn({ status: res.status, gameDate }, 'Weather fetch failed');
      return defaultWeather();
    }

    const data = await res.json() as {
      hourly: {
        time: string[];
        temperature_2m: number[];
        wind_speed_10m: number[];
        precipitation: number[];
        weather_code: number[];
      };
    };

    const hourIndex = Math.min(gameHour, data.hourly.time.length - 1);
    const temp = data.hourly.temperature_2m[hourIndex] ?? 65;
    const wind = data.hourly.wind_speed_10m[hourIndex] ?? 0;
    const precip = data.hourly.precipitation[hourIndex] ?? 0;
    const code = data.hourly.weather_code[hourIndex] ?? 0;

    // WMO weather codes: 71-77 = snow, 51-67 = rain/drizzle, 80-82 = showers
    const isSnow = code >= 71 && code <= 77;
    const isRain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);

    return { temperature: temp, windSpeed: wind, precipitation: precip, weatherCode: code, isSnow, isRain };
  } catch (err) {
    logger.warn({ err }, 'Weather fetch error, using defaults');
    return defaultWeather();
  }
}

function defaultWeather(): WeatherData {
  return { temperature: 65, windSpeed: 5, precipitation: 0, weatherCode: 0, isSnow: false, isRain: false };
}

// ─── Weather adjustments ───────────────────────────────────────────────────────

export interface WeatherAdj {
  windAdj: number;    // total points removed (negative impact on scoring)
  precipAdj: number;
  tempAdj: number;
  windPctAdj: number; // passing EPA multiplier reduction (0–1)
}

export function computeWeatherAdj(weather: WeatherData, isDome: boolean): WeatherAdj {
  if (isDome) {
    return { windAdj: 0, precipAdj: 0, tempAdj: 0, windPctAdj: 0 };
  }

  let windAdj = 0;
  let windPctAdj = 0;
  if (weather.windSpeed > 25) {
    windAdj = -5;
    windPctAdj = 0.12;
  } else if (weather.windSpeed > 15) {
    windAdj = -2;
    windPctAdj = 0.05;
  }

  let precipAdj = 0;
  if (weather.isSnow) {
    precipAdj = -5;
  } else if (weather.isRain || weather.precipitation > 2) {
    precipAdj = -3;
  }

  let tempAdj = 0;
  if (weather.temperature < 20) {
    tempAdj = -3;
  } else if (weather.temperature < 30) {
    tempAdj = -1.5;
  }

  return { windAdj, precipAdj, tempAdj, windPctAdj };
}
