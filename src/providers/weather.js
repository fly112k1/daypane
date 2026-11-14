import { fetchJson, cached } from '../cache.js';
import { getConfig } from '../config.js';

// WMO weather code -> short Chinese description.
const WMO = {
  0: '晴', 1: '少云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨',
  56: '冻毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷雹', 99: '强雷雹'
};
const wmo = (c) => WMO[c] ?? `码${c}`;

export async function getWeather() {
  const { lat, lon, city } = getConfig().weather;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    `&current=temperature_2m,weather_code,relative_humidity_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
    `&timezone=auto&forecast_days=1`;

  // 配置可在服务运行中热改。key 里必须带上坐标和城市名，否则改了城市之后的
  // 10 分钟里，画面会显示"新城市 + 老城市的温度"，还带着旧的 fetchedAt。
  return cached('weather:' + city + ':' + lat + ',' + lon, 10 * 60 * 1000, async () => {
    const r = await fetchJson(url);
    if (!r.ok) return { ok: false, error: r.error, city };
    const c = r.data.current || {};
    const d = (r.data.daily || {});
    const num = (v) => {
      const n = Number(v);
      return v === null || v === '' || v === undefined || !Number.isFinite(n) ? null : n;
    };
    // 温度是整块天气卡的主数值：上游返回 null/字符串/"N/A" 时宁可标不可用，
    // 也不要画出 "null°C  Hnull Lnull" 这种图。
    const temp = num(c.temperature_2m);
    if (temp === null) return { ok: false, error: 'invalid weather payload', city };
    const code = num(c.weather_code);
    return {
      ok: true,
      city,
      temp,
      humidity: num(c.relative_humidity_2m),
      code,
      text: code === null ? '' : wmo(code),
      high: num(d.temperature_2m_max?.[0]),
      low: num(d.temperature_2m_min?.[0]),
      source: 'open-meteo'
    };
  });
}
