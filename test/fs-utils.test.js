'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_REPLACE_RETRY_DELAYS_MS,
  isTransientReplaceError,
  replaceFileWithRetry
} = require('../src/main/fs-utils');

function errorWithCode(code) {
  const error = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

test('isTransientReplaceError recognizes Windows sharing failures', () => {
  assert.equal(isTransientReplaceError(errorWithCode('EPERM')), true);
  assert.equal(isTransientReplaceError(errorWithCode('EACCES')), true);
  assert.equal(isTransientReplaceError(errorWithCode('EBUSY')), true);
  assert.equal(isTransientReplaceError(errorWithCode('ENOENT')), false);
  assert.equal(isTransientReplaceError(errorWithCode('EXDEV')), false);
  assert.equal(isTransientReplaceError(null), false);
});

test('replaceFileWithRetry retries transient rename failures', async () => {
  let calls = 0;
  const rename = async () => {
    calls += 1;
    if (calls < 3) throw errorWithCode('EPERM');
  };

  const result = await replaceFileWithRetry('source', 'target', {
    rename,
    delaysMs: [0, 0, 0]
  });

  assert.deepEqual(result, { ok: true, attempts: 3 });
  assert.equal(calls, 3);
});

test('replaceFileWithRetry does not retry a missing source', async () => {
  let calls = 0;
  const rename = async () => {
    calls += 1;
    throw errorWithCode('ENOENT');
  };

  await assert.rejects(
    replaceFileWithRetry('source', 'target', { rename, delaysMs: [0, 0, 0] }),
    /simulated ENOENT/
  );
  assert.equal(calls, 1);
});

test('replaceFileWithRetry stops after the configured attempts', async () => {
  let calls = 0;
  const rename = async () => {
    calls += 1;
    throw errorWithCode('EBUSY');
  };

  await assert.rejects(
    replaceFileWithRetry('source', 'target', { rename, delaysMs: [0, 0] }),
    /simulated EBUSY/
  );
  assert.equal(calls, 3);
});

test('replaceFileWithRetry moves a real file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-replace-'));
  const source = path.join(dir, 'tool.download');
  const target = path.join(dir, 'tool.exe');
  try {
    fs.writeFileSync(source, 'new binary');
    fs.writeFileSync(target, 'old binary');
    await replaceFileWithRetry(source, target, { delaysMs: [0] });
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new binary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replace retry delays cover a long antivirus scan without unbounded waits', () => {
  const total = DEFAULT_REPLACE_RETRY_DELAYS_MS.reduce((sum, value) => sum + value, 0);
  assert.ok(total >= 4000 && total <= 10000, `unexpected retry window: ${total}ms`);
});
