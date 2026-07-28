import {
  buildPlanReadySummary,
  buildStepDoneSummary,
  buildToolDoneSummary,
  buildToolErrorSummary,
} from './trace-summary.builder';

describe('TraceSummaryBuilder', () => {
  describe('buildToolDoneSummary', () => {
    it('uses the registered extractor for known tools with parsed object output', () => {
      const summary = buildToolDoneSummary(
        'getWeather',
        { city: '深圳' },
        { temperature: 30 },
      );
      expect(summary).toBe('已使用 getWeather，成功查询到深圳天气');
    });

    it('parses stringified args before extraction', () => {
      const summary = buildToolDoneSummary(
        'getWeather',
        JSON.stringify({ location: '北京' }),
        { temperature: 12 },
      );
      expect(summary).toBe('已使用 getWeather，成功查询到北京天气');
    });

    it('falls back to a generic phrasing for unknown tools', () => {
      const summary = buildToolDoneSummary('searchDocs', { q: 'nest' }, {});
      expect(summary).toBe('已使用 searchDocs，调用完成');
    });

    it('summarizes webSearch with the query from args', () => {
      const summary = buildToolDoneSummary(
        'webSearch',
        { query: '2026 亚运会' },
        '联网搜索结果（共 3 条）：...',
      );
      expect(summary).toBe('已使用 webSearch，已联网搜索「2026 亚运会」');
    });

    it('uses a default tool label when name is missing', () => {
      const summary = buildToolDoneSummary(undefined, undefined, undefined);
      expect(summary).toBe('已使用 工具，调用完成');
    });
  });

  describe('buildToolErrorSummary', () => {
    it('includes the error message from an error object', () => {
      const summary = buildToolErrorSummary('getWeather', {
        message: '城市不存在',
      });
      expect(summary).toBe('getWeather 调用失败：城市不存在');
    });

    it('accepts a string error', () => {
      const summary = buildToolErrorSummary('getWeather', '网络超时');
      expect(summary).toBe('getWeather 调用失败：网络超时');
    });

    it('omits the reason when none is available', () => {
      const summary = buildToolErrorSummary('getWeather', undefined);
      expect(summary).toBe('getWeather 调用失败');
    });
  });

  describe('buildPlanReadySummary', () => {
    it('includes the step count', () => {
      expect(buildPlanReadySummary(3)).toBe('任务清单创建完成，共 3 步');
    });

    it('omits the count when it is missing or non-positive', () => {
      expect(buildPlanReadySummary(0)).toBe('任务清单创建完成');
      expect(buildPlanReadySummary(undefined)).toBe('任务清单创建完成');
    });
  });

  describe('buildStepDoneSummary', () => {
    it('includes the step index and goal', () => {
      expect(buildStepDoneSummary(2, '已获取天气数据')).toBe(
        '第 2 步完成：已获取天气数据',
      );
    });

    it('omits the index when it is missing', () => {
      expect(buildStepDoneSummary(undefined, '已获取天气数据')).toBe(
        '步骤完成：已获取天气数据',
      );
    });

    it('degrades to a bare prefix when goal is empty', () => {
      expect(buildStepDoneSummary(1, '   ')).toBe('第 1 步完成');
    });
  });
});
