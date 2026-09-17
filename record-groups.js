(() => {
  'use strict';

  const QUALITY_REASONS = new Set([
    'titleKeyword', 'upKeyword', 'categoryKeyword', 'tagKeyword', 'quality', 'qualityDetail'
  ]);

  function groupRecords(records) {
    const groups = [
      { id: 'quality', title: '质量问题', description: '关键词命中、质量评分不达标', records: [] },
      { id: 'special', title: '特殊样式', description: '番剧、直播等特殊推荐卡片', records: [] },
      { id: 'other', title: '其他屏蔽', description: '屏蔽名单等其他原因', records: [] }
    ];
    records.forEach((record) => {
      const reasons = Array.isArray(record.reasons) ? record.reasons : [];
      // Classify by the recorded rule, never by title text (e.g. “纪录片”).
      // Mixed matches appear once under quality, retaining every reason badge.
      const index = reasons.some((reason) => QUALITY_REASONS.has(reason.type)) ? 0
        : reasons.some((reason) => reason.type === 'specialType') ? 1 : 2;
      groups[index].records.push(record);
    });
    return groups;
  }

  globalThis.BTFRecordGroups = { groupRecords };
})();
