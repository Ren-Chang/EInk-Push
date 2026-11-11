// 习惯打卡的纯逻辑：日期键、频率周期、得分、连续记录、打卡增删、首页布局。
//
// 这里不碰 fs、canvas 与网络，所以可以像普通函数一样单测（见 test/apps-habit.test.js）。
// 灵感来自 Android 的 Loop Habit Tracker：习惯有「周期 + 目标次数」的频率，得分按时间衰减，
// 历史用一张格子图看。墨水屏只有 400×300，所以首页只放一个收藏或四宫格，详情页再看历史。
//
// 兼容旧数据：早期习惯只有 `freq`（每周 1～7 次），没有 period/target。
// habitPeriod()/habitTarget() 会把它们当作「每周 freq 次」，旧测试和旧 state.json 都能继续用。

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const PERIODS = ['week', 'month', 'quarter'];
const PERIOD_DAYS = { week: 7, month: 30.4375, quarter: 91.3125 };
const MAX_TARGET = 10000;

/** 本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC，晚上会差一天） */
export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 用当地正午解析，避开夏令时与跨时区偏移 */
export function parseKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  return dateKey(parseKey(value)) === value;
}

export function addDays(key, delta) {
  const date = parseKey(key);
  date.setDate(date.getDate() + delta);
  return dateKey(date);
}

export function daysBetween(fromKey, toKey) {
  return Math.round((parseKey(toKey) - parseKey(fromKey)) / DAY_MS);
}

/** 0=周一 … 6=周日 */
export function weekdayIndex(key) {
  return (parseKey(key).getDay() + 6) % 7;
}

export function weekStart(key) {
  return addDays(key, -weekdayIndex(key));
}

export function monthDayLabel(key) {
  const date = parseKey(key);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[weekdayIndex(key)]}`;
}

/** 首页和列表用的短日期：只保留月日 */
export function shortDateLabel(key) {
  if (!key) return '—';
  const date = parseKey(key);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

// ---- 频率：周期 + 目标次数 ----

export function clampFrequency(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 7;
  return Math.min(7, Math.max(1, n));
}

export function clampPeriod(value) {
  return PERIODS.includes(value) ? value : 'week';
}

/** 目标次数允许任意正整数（旧界面只能每周 1～7 次，现在放宽到 10000） */
export function clampTarget(value, fallback = 1) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TARGET, Math.max(1, n));
}

/** 习惯的周期；旧数据没有 period 时按周处理 */
export function habitPeriod(habit) {
  return PERIODS.includes(habit?.period) ? habit.period : 'week';
}

/** 习惯每周期目标次数；旧数据用 freq 兼容 */
export function habitTarget(habit) {
  if (habit?.target !== undefined && habit?.target !== null) return clampTarget(habit.target);
  if (habit?.freq !== undefined && habit?.freq !== null) return clampFrequency(habit.freq);
  return 7;
}

export function frequencyLabel(habit) {
  const period = habitPeriod(habit);
  const target = habitTarget(habit);
  if (period === 'week') return target >= 7 ? '每天' : `每周 ${target} 次`;
  if (period === 'month') return `每月 ${target} 次`;
  return `每季度 ${target} 次`;
}

/** 首页/详情里的「连续 N」单位 */
export function streakUnit(habit) {
  const period = habitPeriod(habit);
  if (period === 'week') return habitTarget(habit) >= 7 ? '天' : '周';
  return period === 'month' ? '月' : '季';
}

/** 周期在详情右侧的短名字 */
export function periodName(habit) {
  const period = habitPeriod(habit);
  if (period === 'week') return '本周';
  return period === 'month' ? '本月' : '本季';
}

// ---- 周期边界与计数 ----

/** 包含 dateKey 的周期起止日 */
export function periodBounds(key, period = 'week') {
  const p = clampPeriod(period);
  if (p === 'week') {
    const start = weekStart(key);
    return { start, end: addDays(start, 6) };
  }
  const date = parseKey(key);
  const y = date.getFullYear();
  const m = date.getMonth();
  if (p === 'month') {
    return {
      start: dateKey(new Date(y, m, 1, 12)),
      end: dateKey(new Date(y, m + 1, 0, 12)),
    };
  }
  const firstMonth = Math.floor(m / 3) * 3;
  return {
    start: dateKey(new Date(y, firstMonth, 1, 12)),
    end: dateKey(new Date(y, firstMonth + 3, 0, 12)),
  };
}

export function periodDays(key, period = 'week') {
  const { start, end } = periodBounds(key, period);
  return daysBetween(start, end) + 1;
}

/** 往后/往前挪一个周期，落在新周期第一天 */
export function shiftPeriod(key, period, delta) {
  const p = clampPeriod(period);
  const { start } = periodBounds(key, p);
  const date = parseKey(start);
  if (p === 'week') return addDays(start, delta * 7);
  date.setMonth(date.getMonth() + delta * (p === 'month' ? 1 : 3));
  return dateKey(date);
}

/** 某个周期内完成了几天 */
export function periodCount(entries, habit, key) {
  const { start, end } = periodBounds(key, habitPeriod(habit));
  let count = 0;
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    if (isDone(entries, habit.id, cursor)) count += 1;
  }
  return count;
}

/** 旧名字保留：某一周（周一起算）完成了几天 */
export function weekCount(entries, habitId, startKey) {
  let count = 0;
  for (let i = 0; i < 7; i++) {
    if (isDone(entries, habitId, addDays(startKey, i))) count += 1;
  }
  return count;
}

// ---- 新建习惯 ----

/**
 * 新建习惯。id 用时间戳 + 随机后缀即可：本地单用户，不需要全局唯一性保证。
 * @param {{name: string, period?: string, target?: number, freq?: number}} input
 * @param {{now?: Date, random?: () => number}} [options]
 */
export function createHabit(input, options = {}) {
  const name = String(input?.name ?? '').trim();
  if (!name) throw new Error('习惯名称不能为空');
  if (name.length > 40) throw new Error('习惯名称最多 40 个字符');
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const suffix = Math.floor(random() * 0x10000).toString(16).padStart(4, '0');
  const period = clampPeriod(input?.period);
  const fallbackTarget = period === 'week' ? 7 : 1;
  const target = input?.target !== undefined
    ? clampTarget(input.target, fallbackTarget)
    : input?.freq !== undefined
      ? (period === 'week' ? clampFrequency(input.freq) : clampTarget(input.freq, fallbackTarget))
      : fallbackTarget;
  return {
    id: `h${now.getTime().toString(36)}${suffix}`,
    name,
    period,
    target,
    // 兼容旧代码/旧页面：周频率仍然镜像到 freq
    freq: period === 'week' ? Math.min(7, target) : target,
    createdAt: dateKey(now),
  };
}

// ---- 打卡记录：entries[habitId][dateKey] = 次数（1 表示完成一次） ----

export function entryValue(entries, habitId, key) {
  const value = Number(entries?.[habitId]?.[key]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isDone(entries, habitId, key) {
  return entryValue(entries, habitId, key) > 0;
}

/** 返回新的 entries（不改入参），方便测试与回滚 */
export function toggleEntry(entries, habitId, key) {
  const next = { ...(entries ?? {}) };
  const days = { ...(next[habitId] ?? {}) };
  if (days[key]) delete days[key];
  else days[key] = 1;
  if (Object.keys(days).length) next[habitId] = days;
  else delete next[habitId];
  return next;
}

export function removeHabitEntries(entries, habitId) {
  const next = { ...(entries ?? {}) };
  delete next[habitId];
  return next;
}

// ---- 首页统计：累计次数与最近一次 ----

export function checkCount(entries, habitId) {
  const days = entries?.[habitId] ?? {};
  let count = 0;
  for (const value of Object.values(days)) {
    if (Number(value) > 0) count += 1;
  }
  return count;
}

export function lastChecked(entries, habitId) {
  const days = entries?.[habitId] ?? {};
  let latest = null;
  for (const [key, value] of Object.entries(days)) {
    if (Number(value) > 0 && (!latest || key > latest)) latest = key;
  }
  return latest;
}

// ---- 统计 ----

/**
 * Loop 式的「得分」：每次打卡按时间指数衰减后加总，除以同一窗口内按频率应完成的加权次数。
 * 半衰期 13 天与 Loop 默认一致，所以「最近做得怎么样」比「历史总量」更重要。
 * 月/季度用平均天数换算成「每天应完成多少次」，窗口仍是 90 天。
 * @returns {number} 0～1
 */
export function score(habit, entries, today, options = {}) {
  const windowDays = options.windowDays ?? 90;
  const halfLife = options.halfLife ?? 13;
  let weightSum = 0;
  let doneWeight = 0;
  for (let offset = 0; offset < windowDays; offset += 1) {
    const key = addDays(today, -offset);
    if (key < habit.createdAt) break;
    const weight = Math.pow(0.5, offset / halfLife);
    weightSum += weight;
    if (isDone(entries, habit.id, key)) doneWeight += weight;
  }
  const expected = weightSum * (habitTarget(habit) / PERIOD_DAYS[habitPeriod(habit)]);
  if (expected <= 0) return 0;
  return Math.max(0, Math.min(1, doneWeight / expected));
}

/**
 * 当前连续：
 * - 每天（周目标 ≥ 7）按天算；
 * - 其它按「连续达标的周期」算（周/月/季度），今天/本周期没完成也允许从上一周期续上。
 */
export function streak(habit, entries, today) {
  const period = habitPeriod(habit);
  const target = habitTarget(habit);
  if (period === 'week' && target >= 7) {
    let cursor = isDone(entries, habit.id, today) ? today : addDays(today, -1);
    let count = 0;
    while (isDone(entries, habit.id, cursor) && count < 3650) {
      count += 1;
      cursor = addDays(cursor, -1);
    }
    return count;
  }
  let cursor = periodBounds(today, period).start;
  if (periodCount(entries, habit, cursor) < target) cursor = shiftPeriod(cursor, period, -1);
  let count = 0;
  while (periodCount(entries, habit, cursor) >= target && count < 520) {
    count += 1;
    cursor = shiftPeriod(cursor, period, -1);
  }
  return count;
}

/** 历史最佳连续 */
export function bestStreak(habit, entries, today) {
  const period = habitPeriod(habit);
  const target = habitTarget(habit);
  let best = 0;
  if (period === 'week' && target >= 7) {
    const span = Math.min(3650, Math.max(0, daysBetween(habit.createdAt, today)));
    let run = 0;
    for (let offset = 0; offset <= span; offset += 1) {
      if (isDone(entries, habit.id, addDays(habit.createdAt, offset))) {
        run += 1;
        best = Math.max(best, run);
      } else {
        run = 0;
      }
    }
    return best;
  }
  const start = periodBounds(habit.createdAt, period).start;
  const todayStart = periodBounds(today, period).start;
  let span = 0;
  for (let cursor = start; cursor < todayStart && span < 520; cursor = shiftPeriod(cursor, period, 1)) {
    span += 1;
  }
  let cursor = start;
  let run = 0;
  for (let offset = 0; offset <= span; offset += 1) {
    if (periodCount(entries, habit, cursor) >= target) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
    cursor = shiftPeriod(cursor, period, 1);
  }
  return best;
}

export function habitStats(habit, entries, today) {
  return {
    doneToday: isDone(entries, habit.id, today),
    score: score(habit, entries, today),
    streak: streak(habit, entries, today),
    best: bestStreak(habit, entries, today),
    week: weekCount(entries, habit.id, weekStart(today)),
    periodDone: periodCount(entries, habit, today),
    count: checkCount(entries, habit.id),
    lastChecked: lastChecked(entries, habit.id),
    lastLabel: shortDateLabel(lastChecked(entries, habit.id)),
  };
}

/**
 * 首页卡片上的两组信息：
 * - 左：本周期完成度（例如每周 5 次 → 1 / 5）；
 * - 右：今天没打卡时显示最近打卡日期；今天已打卡时改成累计次数，
 *   因为刚打完卡再显示「今天」没有信息量。
 */
export function homeCardStats(habit, entries, today) {
  const stats = habitStats(habit, entries, today);
  return {
    doneToday: stats.doneToday,
    periodLabel: periodName(habit),
    periodValue: `${stats.periodDone} / ${habitTarget(habit)}`,
    rightLabel: stats.doneToday ? '累计打卡' : '最近打卡',
    rightValue: stats.doneToday ? `${stats.count} 次` : stats.lastLabel,
  };
}

export function todayDone(habits, entries, today) {
  return habits.filter((habit) => isDone(entries, habit.id, today)).length;
}

/** 焦点：显式指定优先，否则第一个今天还没打卡的（全打完就停在第一个） */
export function pickFocus(habits, entries, today, preferredId = null) {
  if (!Array.isArray(habits) || habits.length === 0) return -1;
  if (preferredId) {
    const index = habits.findIndex((habit) => habit.id === preferredId);
    if (index >= 0) return index;
  }
  const pending = habits.findIndex((habit) => !isDone(entries, habit.id, today));
  return pending >= 0 ? pending : 0;
}

/** 焦点打卡后自动前进到下一个未完成项，让「连按确认」能一路打完今天的习惯 */
export function nextFocus(habits, entries, today, currentIndex) {
  if (!habits.length) return -1;
  for (let step = 1; step <= habits.length; step += 1) {
    const index = (currentIndex + step) % habits.length;
    if (!isDone(entries, habits[index].id, today)) return index;
  }
  return currentIndex;
}

// ---- 首页布局：一个收藏 或 四宫格 ----

/**
 * 计算首页显示内容。
 * - homeMode='single'：显示 selectedId 指向的一个习惯；设备上长按上下翻全部习惯；
 * - homeMode='quadrant'：显示 quadrantIds（1～4 个，只有这些是网页里「收藏」的），
 *   设备首页会按数量自动排版；一个都没选时显示空状态。
 * @param {object[]} habits
 * @param {{selectedId?: string|null, quadrantIds?: string[], homeMode?: string}} settings
 * @returns {{mode: 'single'|'quadrant', slots: object[]}}
 */
export function homeLayout(habits, settings = {}) {
  const list = Array.isArray(habits) ? habits : [];
  const byId = new Map(list.map((habit) => [habit.id, habit]));
  const quadrant = [];
  const seen = new Set();
  for (const id of Array.isArray(settings.quadrantIds) ? settings.quadrantIds : []) {
    const habit = byId.get(id);
    if (!habit || seen.has(id)) continue;
    seen.add(id);
    quadrant.push(habit);
    if (quadrant.length >= 4) break;
  }
  const mode = settings.homeMode === 'quadrant' ? 'quadrant' : 'single';

  if (mode === 'quadrant') return { mode: 'quadrant', slots: quadrant };
  const current = byId.get(settings.selectedId) ?? list[0] ?? null;
  return { mode: 'single', slots: current ? [current] : [] };
}

/** 历史格子：从今天所在周往前数 weeks 周，按周排列 */
export function historyWeeks(habit, entries, today, weeks = 12) {
  const current = weekStart(today);
  const columns = [];
  for (let offset = weeks - 1; offset >= 0; offset -= 1) {
    const start = addDays(current, -offset * 7);
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      const key = addDays(start, i);
      days.push({
        key,
        done: isDone(entries, habit.id, key),
        future: key > today,
        beforeStart: key < habit.createdAt,
      });
    }
    columns.push({ start, days });
  }
  return columns;
}

export { WEEKDAYS };
