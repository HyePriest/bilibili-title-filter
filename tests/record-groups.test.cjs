const assert = require('node:assert/strict');
require('../record-groups.js');
const record = (id, types, title = id) => ({ id, title, reasons: types.map(type => ({ type })) });
const records = [
  record('keyword', ['titleKeyword'], '大型纪录片'),
  record('upKeyword', ['upKeyword'], '纪录片'),
  record('score', ['quality', 'qualityDetail']),
  record('anime', ['specialType']),
  record('documentaryBadge', ['specialType'], '纪录片'),
  record('mixed', ['specialType', 'titleKeyword']),
  record('blocked', ['upUid']),
  { id: 'legacy' }
];
const before = JSON.stringify(records);
const groups = BTFRecordGroups.groupRecords(records);
assert.deepEqual(groups[0].records.map(r => r.id), ['keyword', 'upKeyword', 'score', 'mixed']);
assert.deepEqual(groups[1].records.map(r => r.id), ['anime', 'documentaryBadge']);
assert.deepEqual(groups[2].records.map(r => r.id), ['blocked', 'legacy']);
assert.equal(groups.flatMap(g => g.records).length, records.length);
assert.equal(JSON.stringify(records), before);
assert.ok(BTFRecordGroups.groupRecords([]).every(g => g.records.length === 0));
console.log('PASS: keyword/special/quality/mixed/legacy grouping, no duplicates or mutations');
