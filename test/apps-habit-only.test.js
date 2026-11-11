// 挑战模式：只加载 habit 一个应用，根路径直接跳到 /apps/habit/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

test('挑战模式：只加载 habit，根路径跳到 /apps/habit/', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-habit-only-'));
  const app = createServer({
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'config.json'),
    auth: false,
    appsInclude: ['habit'],
    defaultApp: 'habit',
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const list = await (await fetch(`${base}/api/apps`)).json();
    assert.deepEqual(list.apps.map((entry) => entry.id), ['habit']);

    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 307);
    assert.equal(root.headers.get('location'), '/apps/habit/');

    const page = await fetch(`${base}/apps/habit/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /class="shell-nav"/);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
