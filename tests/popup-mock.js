(() => {
  const changes = [];
  const messages = [];
  const record = (id, title, reasons) => ({ id, title, upName: '测试UP', matchedAt: Date.now(), reasons });
  const records = [
    record('keyword', '大型纪录片：测试关键词视频', [{ type: 'titleKeyword', label: '标题关键词：大型纪录片' }]),
    record('low-score', '测试低互动视频', [{ type: 'quality', label: '质量分24（阈值42）' }, { type: 'qualityDetail', label: '投币收藏偏低' }]),
    record('anime', '测试番剧推荐', [{ type: 'specialType', label: '特殊类型：番剧' }]),
    record('blacklist', '测试屏蔽名单视频', [{ type: 'upUid', label: '屏蔽名单：测试UP' }])
  ];
  const values = { sync: { btfSpecialTypesVersion: 2 }, local: { btfBlockedHistory: records } };
  const storage = area => ({
    get(defaults, callback) { queueMicrotask(() => callback({ ...defaults, ...values[area] })); },
    set(next, callback) {
      const updates = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, { oldValue: values[area][key], newValue: value }]));
      Object.assign(values[area], next);
      queueMicrotask(() => { callback?.(); changes.forEach(fn => fn(updates, area)); });
    }
  });
  window.chrome = {
    storage: { sync: storage('sync'), local: storage('local'), onChanged: { addListener(fn) { changes.push(fn); } } },
    runtime: { onMessage: { addListener(fn) { messages.push(fn); } }, openOptionsPage() {} },
    tabs: {
      async query() { return [{ id: 1, url: 'https://www.bilibili.com/' }]; },
      sendMessage(_id, message, callback) {
        const enabled = values.sync.btfEnabled !== false;
        callback(message.type === 'BTF_GET_STATE' ? { active: true, enabled, records: enabled ? records : [] } : { ok: true });
      }
    }
  };
  window.fetch = () => Promise.reject(new Error('Network disabled in popup test'));
})();
