// 习惯数据落盘：data/habit/state.json。
//
// 写入用「临时文件 + rename」，断电或进程被杀时不会留下半截 JSON。
// 读到的内容坏了就当作空状态并保留原文件（下一次写入才会覆盖），不阻塞应用启动。

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  clampFrequency, clampPeriod, clampTarget, isDateKey, dateKey,
} from './state.js';

export const VERSION = 3;
const HOME_MODES = ['single', 'quadrant'];

export function emptyState(now = new Date()) {
  return {
    version: VERSION,
    habits: [],
    entries: {},
    selectedId: null,
    quadrantIds: [],
    homeMode: 'single',
    createdAt: dateKey(now),
  };
}

function normalizeHabit(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  if (!id || !name) return null;
  const createdAt = isDateKey(raw.createdAt) ? raw.createdAt : null;
  if (!createdAt) return null;
  const period = clampPeriod(raw.period);
  // 旧数据只有 freq：按每周 freq 次读入；新周期的次数允许任意正整数
  const target = raw.target !== undefined
    ? clampTarget(raw.target)
    : period === 'week'
      ? clampFrequency(raw.freq)
      : clampTarget(raw.freq ?? 1);
  return {
    id,
    name,
    period,
    target,
    freq: period === 'week' ? Math.min(7, target) : target,
    createdAt,
    order: Number.isFinite(raw.order) ? raw.order : index,
  };
}

/** 清洗外部数据：只保留合法习惯与合法日期的记录 */
export function normalizeState(raw, fallback = emptyState()) {
  if (!raw || typeof raw !== 'object') return fallback;
  const habits = (Array.isArray(raw.habits) ? raw.habits : [])
    .map(normalizeHabit)
    .filter(Boolean);
  const keep = new Set(habits.map((habit) => habit.id));
  const entries = {};
  for (const [habitId, days] of Object.entries(raw.entries ?? {})) {
    if (!keep.has(habitId) || !days || typeof days !== 'object') continue;
    const clean = {};
    for (const [key, value] of Object.entries(days)) {
      if (!isDateKey(key)) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) clean[key] = n;
    }
    if (Object.keys(clean).length) entries[habitId] = clean;
  }
  // 旧版只有一个 favoriteId：迁移成单卡当前习惯
  const legacyFavorite = typeof raw.favoriteId === 'string' && keep.has(raw.favoriteId) ? raw.favoriteId : null;
  const selectedId = typeof raw.selectedId === 'string' && keep.has(raw.selectedId)
    ? raw.selectedId
    : legacyFavorite;
  const quadrantIds = [];
  for (const id of Array.isArray(raw.quadrantIds) ? raw.quadrantIds : []) {
    if (typeof id !== 'string' || !keep.has(id) || quadrantIds.includes(id)) continue;
    quadrantIds.push(id);
    if (quadrantIds.length >= 4) break;
  }
  // 旧 homeMode='favorite' 统一变成单卡
  const homeMode = HOME_MODES.includes(raw.homeMode) ? raw.homeMode : 'single';
  return {
    version: VERSION,
    habits,
    entries,
    selectedId,
    quadrantIds,
    homeMode,
    createdAt: isDateKey(raw.createdAt) ? raw.createdAt : fallback.createdAt,
  };
}

export async function loadState(dir) {
  const file = path.join(dir, 'state.json');
  try {
    const text = await fs.readFile(file, 'utf8');
    return normalizeState(JSON.parse(text));
  } catch {
    return emptyState();
  }
}

/** create() 是同步的，启动时先把数据读进来，避免「服务已监听、状态还没加载」的窗口 */
export function loadStateSync(dir) {
  try {
    const text = readFileSync(path.join(dir, 'state.json'), 'utf8');
    return normalizeState(JSON.parse(text));
  } catch {
    return emptyState();
  }
}

export async function saveState(dir, state) {
  const file = path.join(dir, 'state.json');
  const tmp = `${file}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}
