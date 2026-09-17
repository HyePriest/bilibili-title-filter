(() => {
  'use strict';

  const FILE_NAME = 'bilibili-title-filter-state.json';
  const FORMAT = 'bilibili-title-filter-shared-state';
  const VERSION = 1;
  const DB_NAME = 'btf-shared-state';
  const STORE_NAME = 'handles';
  const HANDLE_KEY = 'shared-directory';

  function normalizeList(value, fallback = []) {
    const list = Array.isArray(value) ? value : fallback;
    return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  }

  function normalizeBlockedUps(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const merged = new Map();
    value.forEach((item) => {
      const uid = String(item?.uid || '').trim();
      if (!/^\d{2,}$/.test(uid)) {
        return;
      }
      const existing = merged.get(uid) || {};
      merged.set(uid, {
        uid,
        name: String(item?.name || existing.name || `UID ${uid}`).trim() || `UID ${uid}`,
        source: item?.source === 'official' || existing.source === 'official' ? 'official' : 'manual'
      });
    });
    return [...merged.values()];
  }

  function normalizeSettings(value = {}) {
    const blockedUpNames = normalizeList(value.blockedUpNames);
    const blockedUps = normalizeBlockedUps(value.blockedUps);
    const savedBlockedOrder = normalizeList(value.blockedOrder)
      .filter((key) => /^(?:uid|name):.+/.test(key));
    const blockedOrder = savedBlockedOrder.length
      ? savedBlockedOrder
      : normalizeList([
        ...blockedUps
          .filter((item) => item.source !== 'official')
          .map((item) => `uid:${item.uid}`),
        ...[...blockedUpNames]
          .reverse()
          .map((name) => `name:${name.toLocaleLowerCase()}`),
        ...blockedUps
          .filter((item) => item.source === 'official')
          .map((item) => `uid:${item.uid}`)
      ]);
    return {
      titleKeywords: normalizeList(value.titleKeywords),
      upKeywords: normalizeList(value.upKeywords),
      categoryKeywords: normalizeList(value.categoryKeywords),
      tagKeywords: normalizeList(value.tagKeywords),
      specialTypes: normalizeList(value.specialTypes),
      blockedUpNames,
      blockedUps,
      blockedOrder
    };
  }

  function mergeSettings(first, second) {
    const a = normalizeSettings(first);
    const b = normalizeSettings(second);
    const blockedUps = new Map();
    [...a.blockedUps, ...b.blockedUps].forEach((item) => {
      const previous = blockedUps.get(item.uid) || {};
      blockedUps.set(item.uid, {
        ...previous,
        ...item,
        name: item.name || previous.name || `UID ${item.uid}`,
        source: item.source === 'official' || previous.source === 'official' ? 'official' : 'manual'
      });
    });
    return {
      titleKeywords: normalizeList([...a.titleKeywords, ...b.titleKeywords]),
      upKeywords: normalizeList([...a.upKeywords, ...b.upKeywords]),
      categoryKeywords: normalizeList([...a.categoryKeywords, ...b.categoryKeywords]),
      tagKeywords: normalizeList([...a.tagKeywords, ...b.tagKeywords]),
      specialTypes: normalizeList([...a.specialTypes, ...b.specialTypes]),
      blockedUpNames: normalizeList([...a.blockedUpNames, ...b.blockedUpNames]),
      blockedUps: [...blockedUps.values()],
      blockedOrder: normalizeList([...b.blockedOrder, ...a.blockedOrder])
    };
  }

  function emptyEnvelope() {
    return {
      format: FORMAT,
      version: VERSION,
      revision: 0,
      updatedAt: null,
      settings: normalizeSettings()
    };
  }

  function normalizeEnvelope(value) {
    if (!value || value.format !== FORMAT || Number(value.version) !== VERSION) {
      return emptyEnvelope();
    }
    return {
      format: FORMAT,
      version: VERSION,
      revision: Math.max(0, Number(value.revision) || 0),
      updatedAt: value.updatedAt || null,
      settings: normalizeSettings(value.settings)
    };
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开共享文件授权记录'));
    });
  }

  async function databaseOperation(mode, operation) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = operation(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('共享文件授权记录操作失败'));
      });
    } finally {
      database.close();
    }
  }

  function getStoredDirectory() {
    return databaseOperation('readonly', (store) => store.get(HANDLE_KEY));
  }

  function storeDirectory(handle) {
    return databaseOperation('readwrite', (store) => store.put(handle, HANDLE_KEY));
  }

  function clearStoredDirectory() {
    return databaseOperation('readwrite', (store) => store.delete(HANDLE_KEY));
  }

  async function verifyPermission(handle, requestPermission = false) {
    if (!handle) {
      return false;
    }
    const options = { mode: 'readwrite' };
    if (await handle.queryPermission(options) === 'granted') {
      return true;
    }
    if (!requestPermission) {
      return false;
    }
    return await handle.requestPermission(options) === 'granted';
  }

  async function chooseDirectory() {
    if (!('showDirectoryPicker' in globalThis)) {
      throw new Error('当前浏览器不支持共享文件夹授权');
    }
    const handle = await globalThis.showDirectoryPicker({
      id: 'btf-shared-state-folder',
      mode: 'readwrite'
    });
    if (!await verifyPermission(handle, true)) {
      throw new Error('没有获得共享文件夹的读写权限');
    }
    await storeDirectory(handle);
    return handle;
  }

  async function getStateFileHandle(directoryHandle) {
    return directoryHandle.getFileHandle(FILE_NAME, { create: true });
  }

  async function read(directoryHandle) {
    const fileHandle = await getStateFileHandle(directoryHandle);
    const file = await fileHandle.getFile();
    if (!file.size) {
      return emptyEnvelope();
    }
    try {
      return normalizeEnvelope(JSON.parse(await file.text()));
    } catch {
      throw new Error(`${FILE_NAME} 内容不是有效的共享状态文件`);
    }
  }

  async function write(directoryHandle, settings, previousRevision = 0) {
    const fileHandle = await getStateFileHandle(directoryHandle);
    const revision = Math.max(Date.now(), Number(previousRevision || 0) + 1);
    const envelope = {
      format: FORMAT,
      version: VERSION,
      revision,
      updatedAt: new Date().toISOString(),
      settings: normalizeSettings(settings)
    };
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(`${JSON.stringify(envelope, null, 2)}\n`);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // The stream can already be closed after a failed commit.
      }
      throw error;
    }
    return envelope;
  }

  globalThis.BTFSharedState = {
    FILE_NAME,
    FORMAT,
    VERSION,
    normalizeSettings,
    mergeSettings,
    normalizeEnvelope,
    getStoredDirectory,
    clearStoredDirectory,
    verifyPermission,
    chooseDirectory,
    read,
    write
  };
})();
