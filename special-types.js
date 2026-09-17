(() => {
  'use strict';

  const DEFAULT_TYPES = Object.freeze([
    '课堂',
    '直播',
    '综艺',
    '番剧',
    '国创',
    '电影',
    '电视剧',
    '纪录片'
  ]);
  const VERSION = 2;
  const URL_RULES = [
    {
      type: '课堂',
      pattern: /cheese\.bilibili\.com|bilibili\.com\/cheese\//i
    },
    {
      type: '直播',
      pattern: /live\.bilibili\.com/i
    }
  ];

  function compactText(value) {
    return String(value || '')
      .trim()
      .toLocaleLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function configuredMap(types) {
    if (types instanceof Map) {
      return types;
    }
    return new Map((Array.isArray(types) ? types : []).map((type) => [compactText(type), type]));
  }

  function matchUrls(urls, types) {
    const wanted = configuredMap(types);
    for (const rule of URL_RULES) {
      const configured = wanted.get(compactText(rule.type));
      if (configured && urls.some((url) => rule.pattern.test(String(url || '')))) {
        return configured;
      }
    }
    return '';
  }

  function matchTextValues(values, types) {
    const wanted = configuredMap(types);
    for (const value of values) {
      const candidate = compactText(value);
      if (!candidate || candidate.length > 16) {
        continue;
      }
      for (const [needle, original] of wanted) {
        if (needle && candidate.includes(needle)) {
          return original;
        }
      }
    }
    return '';
  }

  globalThis.BTFSpecialTypes = {
    DEFAULT_TYPES,
    VERSION,
    compactText,
    compile: configuredMap,
    matchUrls,
    matchTextValues
  };
})();
