// 「习惯」测试：纯逻辑（日期、频率、得分、连续、首页布局）+ 渲染 + 设备按键链路。
// 设备部分用 MockDevice，不碰真机；日期全部写死，避免跨天跑测试时结果漂移。
//
// 注意：confirm+long 在协议里是非法组合（client._validateDevicePacket 会丢弃），
// 所以按键链路只测 confirm 短按与 up/down 长按。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { createServer } from '../src/server.js';
import { KEY, ACTION } from '../src/packet.js';
import {
  dateKey, addDays, daysBetween, weekdayIndex, weekStart, monthDayLabel, isDateKey,
  createHabit, toggleEntry, isDone, entryValue, weekCount, score, streak, bestStreak,
  todayDone, pickFocus, nextFocus, historyWeeks, frequencyLabel, clampTarget, clampPeriod,
  periodCount, homeLayout, homeCardStats, checkCount, lastChecked, habitStats, shortDateLabel,
} from '../apps/habit/state.js';
import { renderHabit, renderHome } from '../apps/habit/render.js';
import { normalizeState } from '../apps/habit/store.js';

const TODAY = '2026-11-11'; // 周三
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 8000, step = 80) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

function habitOf(overrides = {}) {
  return { id: 'h1', name: '读书', freq: 7, createdAt: '2026-10-01', order: 0, ...overrides };
}

function habitList() {
  return [
    habitOf({ id: 'a', name: '读书 20 分钟' }),
    habitOf({ id: 'b', name: '23:30 前睡觉', freq: 5 }),
    habitOf({ id: 'c', name: '跑步', period: 'month', target: 12 }),
    habitOf({ id: 'd', name: '整理房间', period: 'quarter', target: 2 }),
  ];
}

test('日期：本地键、跨月加法、星期与周起点', () => {
  assert.equal(dateKey(new Date(2026, 10, 11, 23, 30)), '2026-11-11');
  assert.equal(addDays('2026-11-11', -11), '2026-10-31');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(daysBetween('2026-10-01', '2026-11-11'), 41);
  assert.equal(weekdayIndex(TODAY), 2);
  assert.equal(weekStart(TODAY), '2026-11-09');
  assert.equal(monthDayLabel(TODAY), '11月11日 周三');
  assert.equal(shortDateLabel(TODAY), '11月11日');
  assert.equal(shortDateLabel(null), '—');
  assert.equal(isDateKey('2026-11-11'), true);
  assert.equal(isDateKey('2026-13-01'), false);
  assert.equal(isDateKey('2026-2-1'), false);
});

test('新建习惯：名称校验、旧 freq 兼容、周期与任意目标次数', () => {
  const habit = createHabit({ name: '  早睡  ', freq: 9 }, { now: new Date(2026, 10, 11), random: () => 0.5 });
  assert.equal(habit.name, '早睡');
  assert.equal(habit.period, 'week');
  assert.equal(habit.target, 7);
  assert.equal(habit.freq, 7);
  assert.equal(habit.createdAt, TODAY);
  assert.match(habit.id, /^[a-z0-9]+$/i);
  assert.throws(() => createHabit({ name: '   ' }), /名称不能为空/);
  assert.throws(() => createHabit({ name: 'x'.repeat(41) }), /最多 40/);

  const monthly = createHabit({ name: '跑步', period: 'month', target: 12 });
  assert.equal(monthly.period, 'month');
  assert.equal(monthly.target, 12);
  assert.equal(frequencyLabel(monthly), '每月 12 次');
  const quarterly = createHabit({ name: '体检', period: 'quarter', target: 2 });
  assert.equal(frequencyLabel(quarterly), '每季度 2 次');
  assert.equal(clampTarget(0), 1);
  assert.equal(clampTarget(99999), 10000);
  assert.equal(clampPeriod('year'), 'week');
  assert.equal(frequencyLabel(habitOf()), '每天');
  assert.equal(frequencyLabel(habitOf({ freq: 3 })), '每周 3 次');
});

test('打卡：切换不改入参、重复切换回到原样', () => {
  const base = {};
  const once = toggleEntry(base, 'h1', TODAY);
  assert.equal(isDone(once, 'h1', TODAY), true);
  assert.equal(entryValue(once, 'h1', TODAY), 1);
  assert.deepEqual(base, {}, '不应修改入参');
  const twice = toggleEntry(once, 'h1', TODAY);
  assert.equal(isDone(twice, 'h1', TODAY), false);
  assert.deepEqual(twice, {});
});

test('得分：全勤接近 1，只有很久以前打卡则明显偏低，窗口内无记录为 0', () => {
  const habit = habitOf();
  const all = {};
  for (let offset = 0; offset < 60; offset += 1) all[addDays(TODAY, -offset)] = 1;
  const full = score(habit, { h1: all }, TODAY);
  assert.ok(full > 0.98 && full <= 1, `全勤得分应为 1，得到 ${full}`);

  const old = { h1: { '2026-10-01': 1 } };
  const stale = score(habit, old, TODAY);
  assert.ok(stale < 0.1, `只打过一次旧卡应接近 0，得到 ${stale}`);

  assert.equal(score(habit, {}, TODAY), 0);
});

test('连续：按天允许今天未打卡，按周/月/季度要求达到频率', () => {
  const daily = habitOf();
  const twoDays = { h1: { [TODAY]: 1, [addDays(TODAY, -1)]: 1 } };
  assert.equal(streak(daily, twoDays, TODAY), 2);
  assert.equal(streak(daily, { h1: { [addDays(TODAY, -1)]: 1 } }, TODAY), 1, '今天没打卡也续得上');
  assert.equal(streak(daily, { h1: { [addDays(TODAY, -2)]: 1 } }, TODAY), 0, '断开一天就归零');

  const weekly = habitOf({ freq: 3 });
  const thisWeek = { h1: { '2026-11-09': 1, '2026-11-10': 1, [TODAY]: 1 } };
  assert.equal(weekCount(thisWeek, 'h1', '2026-11-09'), 3);
  assert.equal(streak(weekly, thisWeek, TODAY), 1);
  const previous = { '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 1 };
  assert.equal(streak(weekly, { h1: { ...thisWeek.h1, ...previous } }, TODAY), 2);
  assert.equal(streak(weekly, { h1: { '2026-11-09': 1 } }, TODAY), 0, '本周未达标且上周为空');
});

test('月/季度周期：计数、连续与跨周期边界', () => {
  const monthly = habitOf({ period: 'month', target: 2 });
  const entries = {
    h1: {
      '2026-10-01': 1, '2026-10-20': 1,
      '2026-11-01': 1, '2026-11-02': 1,
    },
  };
  assert.equal(periodCount(entries, monthly, '2026-10-15'), 2);
  assert.equal(periodCount(entries, monthly, '2026-11-11'), 2);
  assert.equal(streak(monthly, entries, TODAY), 2);

  const quarterly = habitOf({ period: 'quarter', target: 3, createdAt: '2026-07-01' });
  const qEntries = {
    h1: {
      '2026-07-01': 1, '2026-08-01': 1, '2026-09-01': 1,
      '2026-10-01': 1, '2026-11-01': 1,
    },
  };
  assert.equal(periodCount(qEntries, quarterly, '2026-08-15'), 3);
  assert.equal(streak(quarterly, qEntries, TODAY), 1, '本季度未达标，从上一季度续上');
  assert.equal(bestStreak(quarterly, qEntries, TODAY), 1);
});

test('最佳连续与历史格子', () => {
  const habit = habitOf();
  const run = {};
  for (let offset = 0; offset < 5; offset += 1) run[addDays('2026-10-05', offset)] = 1;
  assert.equal(bestStreak(habit, { h1: run }, TODAY), 5);

  const weeks = historyWeeks(habit, { h1: run }, TODAY, 12);
  assert.equal(weeks.length, 12);
  assert.equal(weeks.at(-1).start, '2026-11-09');
  assert.ok(weeks.every((column) => column.days.length === 7));
  const flat = weeks.flatMap((column) => column.days);
  assert.ok(flat.some((day) => day.done), '历史格里应有已打卡的格子');
  assert.ok(flat.every((day) => day.key <= TODAY || day.future), '晚于今天的日子必须标记为 future');
});

test('焦点：优先未完成项，打卡后自动前进', () => {
  const habits = [habitOf({ id: 'a' }), habitOf({ id: 'b' }), habitOf({ id: 'c' })];
  const entries = { a: { [TODAY]: 1 } };
  assert.equal(pickFocus(habits, entries, TODAY), 1);
  assert.equal(pickFocus(habits, entries, TODAY, 'c'), 2);
  assert.equal(pickFocus(habits, entries, TODAY, 'a'), 0, '显式指定优先，即使是已完成的');
  assert.equal(pickFocus(habits, entries, TODAY, 'missing'), 1);
  assert.equal(nextFocus(habits, entries, TODAY, 1), 2);
  assert.equal(nextFocus(habits, { a: { [TODAY]: 1 }, b: { [TODAY]: 1 }, c: { [TODAY]: 1 } }, TODAY, 0), 0);
  assert.equal(todayDone(habits, entries, TODAY), 1);
  assert.equal(pickFocus([], {}, TODAY), -1);
});

test('首页布局：单卡用当前习惯；四宫格只显示收藏的四张，空位补 null', () => {
  const habits = habitList();
  const single = homeLayout(habits, { homeMode: 'single', selectedId: 'c', quadrantIds: ['a', 'b', 'd'] });
  assert.equal(single.mode, 'single');
  assert.equal(single.slots.length, 1);
  assert.equal(single.slots[0].id, 'c');

  const quadrant = homeLayout(habits, { homeMode: 'quadrant', selectedId: 'c', quadrantIds: ['a', 'b', 'd'] });
  assert.equal(quadrant.mode, 'quadrant');
  assert.deepEqual(quadrant.slots.map((habit) => habit.id), ['a', 'b', 'd']);

  const emptyQuadrant = homeLayout(habits, { homeMode: 'quadrant', quadrantIds: [] });
  assert.equal(emptyQuadrant.mode, 'quadrant');
  assert.deepEqual(emptyQuadrant.slots, []);

  const fallback = homeLayout(habits, {});
  assert.equal(fallback.mode, 'single');
  assert.equal(fallback.slots[0].id, 'a');

  const legacy = homeLayout(habits, { homeMode: 'favorite', selectedId: 'b' });
  assert.equal(legacy.mode, 'single');
  assert.equal(legacy.slots[0].id, 'b');
});

test('旧数据迁移：favoriteId 变成单卡当前习惯', () => {
  const raw = {
    version: 2,
    habits: [habitOf({ id: 'a' }), habitOf({ id: 'b' })],
    entries: {},
    favoriteId: 'b',
    homeMode: 'favorite',
  };
  const state = normalizeState(raw);
  assert.equal(state.homeMode, 'single');
  assert.equal(state.selectedId, 'b');
  assert.equal(state.favoriteId, undefined);
  assert.deepEqual(state.quadrantIds, []);
});

test('首页统计：累计次数与最近日期', () => {
  const entries = { h1: { '2026-11-01': 1, '2026-11-09': 1, '2026-11-10': 0, [TODAY]: 1 } };
  assert.equal(checkCount(entries, 'h1'), 3);
  assert.equal(lastChecked(entries, 'h1'), TODAY);
  assert.equal(lastChecked({}, 'h1'), null);
  const stats = habitStats(habitOf(), entries, TODAY);
  assert.equal(stats.count, 3);
  assert.equal(stats.lastChecked, TODAY);
  assert.equal(stats.lastLabel, '11月11日');
});

test('首页卡片信息：本周期完成度；今天打卡后右侧改成累计次数', () => {
  const weekly = habitOf({ freq: 5 });
  const before = homeCardStats(weekly, { h1: { '2026-11-09': 1 } }, TODAY);
  assert.equal(before.periodLabel, '本周');
  assert.equal(before.periodValue, '1 / 5');
  assert.equal(before.rightLabel, '最近打卡');
  assert.equal(before.rightValue, '11月9日');

  const after = homeCardStats(weekly, { h1: { '2026-11-09': 1, [TODAY]: 1 } }, TODAY);
  assert.equal(after.periodValue, '2 / 5');
  assert.equal(after.rightLabel, '累计打卡');
  assert.equal(after.rightValue, '2 次');

  const monthly = habitOf({ period: 'month', target: 12 });
  const monthCard = homeCardStats(monthly, { h1: { '2026-11-01': 1 } }, TODAY);
  assert.equal(monthCard.periodLabel, '本月');
  assert.equal(monthCard.periodValue, '1 / 12');
});

test('渲染：首页单卡/四宫格与详情页都是 400×300 且有内容', async () => {
  const habits = habitList();
  const entries = {
    a: { [TODAY]: 1, [addDays(TODAY, -1)]: 1 },
    c: { '2026-11-01': 1, '2026-11-05': 1 },
  };
  const homeLayouts = [
    homeLayout(habits, { homeMode: 'single', selectedId: 'a' }),
    homeLayout(habits, { homeMode: 'quadrant', quadrantIds: ['a'] }),
    homeLayout(habits, { homeMode: 'quadrant', quadrantIds: ['a', 'b'] }),
    homeLayout(habits, { homeMode: 'quadrant', quadrantIds: ['a', 'b', 'c'] }),
    homeLayout(habits, { homeMode: 'quadrant', quadrantIds: ['a', 'b', 'c', 'd'] }),
    homeLayout(habits, { homeMode: 'quadrant', quadrantIds: [] }),
  ];
  for (const layout of homeLayouts) {
    const png = renderHome({ layout, entries, today: TODAY, cursor: 1 });
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);
    const stats = await sharp(png).stats();
    assert.ok(stats.channels[0].mean < 250, `图像应有内容，mean=${stats.channels[0].mean}`);
    assert.ok(png.length > 2000, `PNG 体积异常: ${png.length}`);
  }
  for (const focus of [0, 1]) {
    const png = renderHabit({ habits, entries, today: TODAY, focus });
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);
    assert.ok(png.length > 2000);
  }
  const empty = renderHabit({ habits: [], entries: {}, today: TODAY, focus: 0 });
  assert.ok(empty.length > 2000);
});

test('Web + 设备按键：首页确认打卡/长按上进详情、详情确认回单卡/长按上四宫格、抢屏交还', { timeout: 60000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-habit-'));
  const app = createServer({
    device: `127.0.0.1:${port}`,
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'config.json'),
    auth: false,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = () => fetch(`${base}/apps/habit/api/state`).then((r) => r.json());
  const json = (response) => response.json();
  const addHabit = (name, period = 'week', target = 7) => fetch(`${base}/apps/habit/api/habits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, period, target }),
  }).then(json);

  try {
    const list = await (await fetch(`${base}/api/apps`)).json();
    assert.ok(list.apps.some((item) => item.id === 'habit'), '应用列表应包含 habit');

    const page = await fetch(`${base}/apps/habit/`).then((response) => response.text());
    assert.match(page, /class="shell-nav"/, '页面应带全站统一导航');
    assert.match(page, /href="\/apps"[^>]*>.*应用列表/s, '页面应有返回应用列表的入口');
    assert.match(page, /<h1>习惯<\/h1>/);
    assert.match(page, /api\/home/, '页面应能保存首页收藏/四宫格');

    const first = await addHabit('读书 20 分钟');
    const second = await addHabit('23:30 前睡觉', 'week', 5);
    const third = await addHabit('跑步', 'month', 12);
    const fourth = await addHabit('整理房间', 'quarter', 2);
    for (const result of [first, second, third, fourth]) assert.equal(result.ok, true, JSON.stringify(result));
    const ids = (await state()).habits.map((habit) => habit.id);

    const savedHome = await json(await fetch(`${base}/apps/habit/api/home`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'quadrant', quadrantIds: ids }),
    }));
    assert.equal(savedHome.ok, true, JSON.stringify(savedHome));
    assert.equal(savedHome.homeMode, 'quadrant');
    assert.deepEqual(savedHome.homeIds, ids);
    assert.equal(savedHome.habits[2].period, 'month');
    assert.equal(savedHome.habits[2].target, 12);
    assert.equal(savedHome.habits[3].period, 'quarter');

    const preview = await fetch(`${base}/apps/habit/api/preview.png?view=home`);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    assert.equal(meta.width, 400);

    // 推到设备 = 四宫格首页 + 接管确认键
    const pushed = await json(await fetch(`${base}/apps/habit/api/push`, { method: 'POST' }));
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    assert.ok(await waitFor(() => device.images.size >= 1), '设备应收到图片');
    assert.equal((await state()).active, true);
    assert.equal((await state()).view, 'home');
    assert.equal((await state()).focusId, ids[0], '首页光标应停在第一张卡');

    // 四宫格确认短按：直接打卡，不再进详情
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const quadrantChecked = await waitFor(async () => {
      const current = await state();
      return current.view === 'home' && current.habits[0].stats.doneToday ? current : null;
    });
    assert.ok(quadrantChecked, '四宫格确认键应直接打卡');
    assert.equal(quadrantChecked.detailId, null, '四宫格确认键不应进入详情');
    assert.ok(await waitFor(() => device.images.size >= 2), '打卡后应再推一张');

    // 四宫格长按上：进入详情；详情长按下：切下一个习惯
    device.sendKey(KEY.UP, ACTION.LONG);
    const detail = await waitFor(async () => {
      const current = await state();
      return current.view === 'detail' && current.detailId === ids[0] ? current : null;
    });
    assert.ok(detail, '四宫格长按上应进入详情');
    assert.ok(await waitFor(() => device.images.size >= 3), '进详情后应再推一张');
    device.sendKey(KEY.DOWN, ACTION.LONG);
    const nextDetail = await waitFor(async () => {
      const current = await state();
      return current.view === 'detail' && current.detailId === ids[1] ? current : null;
    });
    assert.ok(nextDetail, '详情页长按下应切到下一个习惯');
    assert.ok(await waitFor(() => device.images.size >= 4), '切详情后应再推一张');

    // 详情长按上：切回四宫格首页
    device.sendKey(KEY.UP, ACTION.LONG);
    const quadrantHome = await waitFor(async () => {
      const current = await state();
      return current.view === 'home' && current.homeMode === 'quadrant' && current.focusId === ids[1] ? current : null;
    });
    assert.ok(quadrantHome, '详情页长按上应切到四宫格首页');
    assert.ok(await waitFor(() => device.images.size >= 5), '回四宫格后应再推一张');

    // 四宫格长按下：光标移到第三张
    device.sendKey(KEY.DOWN, ACTION.LONG);
    assert.ok(await waitFor(async () => (await state()).focusId === ids[2]), '四宫格长按下应移到下一张卡');
    assert.ok(await waitFor(() => device.images.size >= 6), '换卡后应再推一张');

    // 四宫格长按上：进入第三张详情；详情确认：切回单卡且不打卡
    device.sendKey(KEY.UP, ACTION.LONG);
    assert.ok(await waitFor(async () => (await state()).detailId === ids[2]), '应进入第三张卡的详情');
    assert.ok(await waitFor(() => device.images.size >= 7), '进详情后应再推一张');
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const singleAt = await waitFor(async () => {
      const current = await state();
      return current.view === 'home' && current.homeMode === 'single' && current.focusId === ids[2] ? current : null;
    });
    assert.ok(singleAt, '详情页确认应切回当前习惯的单卡');
    assert.deepEqual(singleAt.homeIds, [ids[2]]);
    assert.equal(singleAt.habits[2].stats.doneToday, false, '详情页确认不应打卡');
    assert.ok(await waitFor(() => device.images.size >= 8), '切回单卡后应再推一张');

    // 单卡确认：直接打卡；长按下：翻到下一个习惯；长按上：进详情
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const singleChecked = await waitFor(async () => {
      const current = await state();
      return current.view === 'home' && current.habits[2].stats.doneToday ? current : null;
    });
    assert.ok(singleChecked, '单卡确认键应直接打卡');
    assert.ok(await waitFor(() => device.images.size >= 9), '单卡打卡后应再推一张');
    device.sendKey(KEY.DOWN, ACTION.LONG);
    assert.ok(await waitFor(async () => (await state()).focusId === ids[3]), '单卡长按下应翻到下一个习惯');
    assert.ok(await waitFor(() => device.images.size >= 10), '翻习惯后应再推一张');
    device.sendKey(KEY.UP, ACTION.LONG);
    const singleDetail = await waitFor(async () => {
      const current = await state();
      return current.view === 'detail' && current.detailId === ids[3] ? current : null;
    });
    assert.ok(singleDetail, '单卡长按上应进入详情');
    assert.ok(await waitFor(() => device.images.size >= 11), '进详情后应再推一张');

    // 详情长按上：再次切回四宫格首页
    device.sendKey(KEY.UP, ACTION.LONG);
    const backQuadrant = await waitFor(async () => {
      const current = await state();
      return current.view === 'home' && current.homeMode === 'quadrant' && current.focusId === ids[3] ? current : null;
    });
    assert.ok(backQuadrant, '详情页长按上应切到四宫格');
    assert.ok(await waitFor(() => device.images.size >= 12), '回四宫格后应再推一张');

    // 别的应用推图后，本应用必须交还按键
    await fetch(`${base}/apps/what-to-eat/api/push`, { method: 'POST' });
    assert.ok(await waitFor(() => device.images.size >= 13), '另一个应用也应推图');
    assert.equal((await state()).active, false, '抢屏后确认键租约应失效');

    const before = await state();
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    await sleep(500);
    const after = await state();
    assert.equal(after.habits[3].stats.doneToday, before.habits[3].stats.doneToday, '没有租约时确认键不应改打卡');
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
