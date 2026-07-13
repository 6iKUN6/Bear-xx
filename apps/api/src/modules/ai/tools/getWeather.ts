import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_API_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_FORECAST_DAYS = 3;
const WEATHER_REQUEST_TIMEOUT_MS = 10000;

interface OpenMeteoGeocodingResponse {
  results?: Array<{
    name: string;
    country?: string;
    admin1?: string;
    latitude: number;
    longitude: number;
    timezone?: string;
  }>;
}

interface OpenMeteoForecastResponse {
  timezone?: string;
  current?: {
    temperature_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    wind_speed_10m_max?: number[];
  };
}

const getWeather = tool(
  async (input: {
    city: string;
    countryCode?: string;
    days?: number;
    language?: string;
  }) => {
    try {
      const query = normalizeQuery(input);
      const location = await searchLocation(query);
      const forecast = await fetchForecast(location, query.days);
      return formatWeatherResult(location, forecast, query.days);
    } catch (error) {
      return `天气查询失败：${error instanceof Error ? error.message : String(error)}。请提示用户稍后重试，或让用户补充更明确的城市名称。`;
    }
  },
  {
    name: 'getWeather',
    description:
      '根据城市名称查询当前天气和未来几天天气预报，适合回答天气、气温、降水概率和出行建议相关的问题。',
    schema: z.object({
      city: z.string().min(1).describe('城市名称，例如北京、上海、Tokyo'),
      countryCode: z
        .string()
        .length(2)
        .optional()
        .describe('可选的国家代码，例如 CN、JP、US，用于缩小地理编码范围'),
      days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe('返回未来几天天气，默认 3 天，最大 7 天'),
      language: z
        .string()
        .optional()
        .describe('地理编码返回结果的语言，默认 zh'),
    }),
  },
);

/**
 * 规范化天气查询参数
 * @param input 工具调用输入
 * @returns 返回清洗后的天气查询参数
 * @description 对城市名、国家代码、预测天数和语言参数做兜底与格式标准化，避免下游请求重复处理默认值。
 */
function normalizeQuery(input: {
  city: string;
  countryCode?: string;
  days?: number;
  language?: string;
}) {
  return {
    city: input.city.trim(),
    countryCode: input.countryCode?.trim().toUpperCase(),
    days: input.days ?? DEFAULT_FORECAST_DAYS,
    language: input.language?.trim() || 'zh',
  };
}

/**
 * 搜索城市地理位置
 * @param query 规范化后的天气查询参数
 * @returns 返回首个匹配到的地理位置
 * @description 通过 Open-Meteo 的地理编码接口把城市名称解析为经纬度，供后续天气预报接口调用。
 */
async function searchLocation(query: {
  city: string;
  countryCode?: string;
  days: number;
  language: string;
}) {
  const params = new URLSearchParams({
    name: query.city,
    count: '1',
    language: query.language,
    format: 'json',
  });

  if (query.countryCode) {
    params.set('countryCode', query.countryCode);
  }

  const response = await fetchJson<OpenMeteoGeocodingResponse>(
    `${GEOCODING_API_URL}?${params.toString()}`,
  );
  const location = response.results?.[0];

  if (!location) {
    throw new Error(`未找到城市“${query.city}”对应的天气位置`);
  }

  return location;
}

/**
 * 获取天气预报数据
 * @param location 城市地理位置
 * @param days 预测天数
 * @returns 返回 Open-Meteo 天气预报结果
 * @description 使用经纬度调用 Open-Meteo 预报接口，同时拉取当前天气和未来多天天气摘要。
 */
async function fetchForecast(
  location: {
    latitude: number;
    longitude: number;
  },
  days: number,
) {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: 'auto',
    forecast_days: String(days),
    current: 'temperature_2m,weather_code,wind_speed_10m',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',
  });

  return fetchJson<OpenMeteoForecastResponse>(
    `${FORECAST_API_URL}?${params.toString()}`,
  );
}

/**
 * 拉取 JSON 数据
 * @param url 请求地址
 * @returns 返回解析后的 JSON 数据
 * @description 为天气工具统一处理 fetch、超时、非 2xx 响应和 JSON 解析逻辑，减少重复错误分支。
 */
async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WEATHER_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`天气服务请求失败，状态码：${response.status}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('天气服务请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 格式化天气查询结果
 * @param location 城市地理位置
 * @param forecast 天气预报结果
 * @param days 预测天数
 * @returns 返回供大模型直接消费的中文天气摘要
 * @description 将当前天气、未来多天天气和基础位置信息拼接为稳定的中文文本，降低模型后处理难度。
 */
function formatWeatherResult(
  location: {
    name: string;
    country?: string;
    admin1?: string;
    timezone?: string;
  },
  forecast: OpenMeteoForecastResponse,
  days: number,
) {
  const lines: string[] = [];
  const locationLabel = [location.country, location.admin1, location.name]
    .filter(Boolean)
    .join(' / ');

  lines.push(`天气查询结果：${locationLabel}`);

  if (forecast.timezone || location.timezone) {
    lines.push(`时区：${forecast.timezone ?? location.timezone}`);
  }

  if (forecast.current) {
    const currentWeather = describeWeatherCode(forecast.current.weather_code);
    const currentTemperature = formatTemperature(
      forecast.current.temperature_2m,
    );
    const currentWind = formatWindSpeed(forecast.current.wind_speed_10m);

    lines.push(
      `当前天气：${currentWeather}，气温 ${currentTemperature}${
        currentWind ? `，风速 ${currentWind}` : ''
      }`,
    );
  }

  const dailyTime = forecast.daily?.time ?? [];
  const dailyWeatherCodes = forecast.daily?.weather_code ?? [];
  const dailyMaxTemperatures = forecast.daily?.temperature_2m_max ?? [];
  const dailyMinTemperatures = forecast.daily?.temperature_2m_min ?? [];
  const dailyPrecipitation =
    forecast.daily?.precipitation_probability_max ?? [];
  const dailyWind = forecast.daily?.wind_speed_10m_max ?? [];

  if (dailyTime.length > 0) {
    lines.push(`未来 ${days} 天天气：`);

    for (let index = 0; index < dailyTime.length; index += 1) {
      lines.push(
        `${index + 1}. ${dailyTime[index]}：${describeWeatherCode(
          dailyWeatherCodes[index],
        )}，${formatTemperatureRange(
          dailyMinTemperatures[index],
          dailyMaxTemperatures[index],
        )}，降水概率 ${formatPercentage(
          dailyPrecipitation[index],
        )}，最大风速 ${formatWindSpeed(dailyWind[index])}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * 描述天气代码
 * @param weatherCode Open-Meteo/WMO 天气代码
 * @returns 返回中文天气描述
 * @description 将天气代码映射为更适合用户理解的中文文本，避免把原始数值直接暴露给大模型。
 */
function describeWeatherCode(weatherCode?: number): string {
  const weatherCodeMap: Record<number, string> = {
    0: '晴朗',
    1: '大体晴朗',
    2: '局部多云',
    3: '阴天',
    45: '有雾',
    48: '冻雾',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '强毛毛雨',
    56: '小冻毛毛雨',
    57: '强冻毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    66: '小冻雨',
    67: '强冻雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    77: '雪粒',
    80: '小阵雨',
    81: '中阵雨',
    82: '强阵雨',
    85: '小阵雪',
    86: '强阵雪',
    95: '雷阵雨',
    96: '伴有小冰雹的雷暴',
    99: '伴有大冰雹的强雷暴',
  };

  if (weatherCode === undefined) {
    return '未知';
  }

  return weatherCodeMap[weatherCode] ?? `未知天气(${weatherCode})`;
}

/**
 * 格式化温度
 * @param value 温度值
 * @returns 返回带摄氏度单位的温度文本
 * @description 对当前温度等单值温度字段做统一格式化，缺失时返回未知。
 */
function formatTemperature(value?: number): string {
  if (value === undefined || Number.isNaN(value)) {
    return '未知';
  }

  return `${Math.round(value)}°C`;
}

/**
 * 格式化温度范围
 * @param min 最低温
 * @param max 最高温
 * @returns 返回温度区间文本
 * @description 对逐日最低温和最高温做统一拼接，供预报结果直接展示。
 */
function formatTemperatureRange(min?: number, max?: number): string {
  if (
    min === undefined ||
    max === undefined ||
    Number.isNaN(min) ||
    Number.isNaN(max)
  ) {
    return '气温未知';
  }

  return `${Math.round(min)}°C ~ ${Math.round(max)}°C`;
}

/**
 * 格式化降水概率
 * @param value 降水概率数值
 * @returns 返回百分比文本
 * @description 对天气预报中的降水概率字段做统一格式化，缺失时返回未知。
 */
function formatPercentage(value?: number): string {
  if (value === undefined || Number.isNaN(value)) {
    return '未知';
  }

  return `${Math.round(value)}%`;
}

/**
 * 格式化风速
 * @param value 风速数值
 * @returns 返回带单位的风速文本
 * @description 对当前风速和逐日最大风速做统一格式化，缺失时返回未知。
 */
function formatWindSpeed(value?: number): string {
  if (value === undefined || Number.isNaN(value)) {
    return '未知';
  }

  return `${Math.round(value)} km/h`;
}

export default getWeather;
