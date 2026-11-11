// 「习惯」的 400×300 版面：
//   · renderHome：首页，单卡或 1～4 张收藏卡自动排版；
//   · renderHabit：详情页，保留原来的打卡状态、12 周历史与 Loop 式得分。
//
// 设备只有三个键，确认长按不会上报（协议里 confirm+long 是非法组合），所以层级导航只用：
// 单卡：确认打卡、长按上详情、长按下换习惯；
// 四宫格：长按上下选卡、确认进详情；详情长按下个、长按上回首页。

import {
  WIDTH, HEIGHT, createDeviceCanvas, font, fitText, wrapText,
  roundRect, line, exportPng,
} from '../shared/canvas.js';
import {
  habitStats, homeCardStats, monthDayLabel, todayDone, historyWeeks, WEEKDAYS,
  frequencyLabel, habitPeriod, habitTarget, periodName, streakUnit,
} from './state.js';

const BLACK = '#000000';
const GRAY = '#555555';
const LIGHT = '#9a9a9a';
const IDLE_CELL = '#e2e2e2';
const BORDER = '#b5b5b5';

function text(ctx, value, x, y, size, { color = BLACK, weight = 'normal', align = 'left', maxWidth } = {}) {
  ctx.fillStyle = color;
  const spec = font(size, weight);
  ctx.font = spec;
  ctx.textAlign = align;
  const shown = maxWidth ? fitText(ctx, value, spec, maxWidth) : String(value ?? '');
  ctx.fillText(shown, x, y);
  ctx.textAlign = 'left';
}

function centered(ctx, value, y, size, options = {}) {
  text(ctx, value, WIDTH / 2, y, size, { ...options, align: 'center' });
}

function wrapped(ctx, value, x, y, size, maxWidth, maxLines, options = {}) {
  const spec = font(size, options.weight ?? 'normal');
  ctx.font = spec;
  ctx.fillStyle = options.color ?? BLACK;
  const lines = wrapText(ctx, value, spec, maxWidth, maxLines);
  lines.forEach((lineText, index) => {
    ctx.fillText(lineText, x, y + index * Math.round(size * 1.22));
  });
  return lines.length;
}

function checkbox(ctx, x, y, size, done) {
  roundRect(ctx, x, y, size, size, 6, { fill: done ? BLACK : '#ffffff', stroke: BLACK, lineWidth: 1.6 });
  if (!done) return;
  ctx.beginPath();
  ctx.moveTo(x + size * 0.24, y + size * 0.52);
  ctx.lineTo(x + size * 0.43, y + size * 0.72);
  ctx.lineTo(x + size * 0.78, y + size * 0.28);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

function header(ctx, today) {
  text(ctx, '习惯', 16, 10, 18, { weight: 'bold' });
  text(ctx, monthDayLabel(today), 384, 14, 12, { color: GRAY, align: 'right' });
  line(ctx, 16, 34, 384, 34, BLACK, 1.5);
}

function footer(ctx, message) {
  line(ctx, 16, 262, 384, 262, LIGHT, 1);
  centered(ctx, message, 276, 12, { color: GRAY });
}

/** 首页单卡：本周期完成度 + 最近日期/累计次数 */
function singleCard(ctx, habit, entries, today) {
  const card = homeCardStats(habit, entries, today);
  roundRect(ctx, 16, 50, 368, 198, 12, { fill: '#ffffff', stroke: BLACK, lineWidth: 2 });
  wrapped(ctx, habit.name, 36, 72, 30, 328, 2, { weight: 'bold' });
  line(ctx, 36, 142, 364, 142, LIGHT, 1);

  text(ctx, card.periodLabel, 36, 156, 12, { color: GRAY });
  text(ctx, card.periodValue, 36, 176, 30, { weight: 'bold' });
  text(ctx, card.rightLabel, 212, 156, 12, { color: GRAY });
  text(ctx, card.rightValue, 212, 178, card.doneToday ? 28 : 22, { weight: 'bold' });
}

/** 半屏宽的横向卡：名字在左，单卡统计在右 */
function wideCard(ctx, habit, entries, today, x, y, w, h, focused) {
  const card = homeCardStats(habit, entries, today);
  roundRect(ctx, x, y, w, h, 10, {
    fill: '#ffffff',
    stroke: focused ? BLACK : BORDER,
    lineWidth: focused ? 2.6 : 1.2,
  });
  const statsX = x + Math.round(w * 0.53);
  wrapped(ctx, habit.name, x + 14, y + 18, 20, statsX - x - 28, 2, { weight: 'bold' });

  text(ctx, `${card.periodLabel} ${card.periodValue}`, statsX, y + 18, 13, { weight: 'bold' });
  text(ctx, `${card.rightLabel} ${card.rightValue}`, statsX, y + 44, 12, { color: GRAY, maxWidth: (x + w) - statsX - 12 });
}

/** 四宫格里的小卡：两行紧凑信息 */
function smallCard(ctx, habit, entries, today, x, y, w, h, focused) {
  const card = homeCardStats(habit, entries, today);
  roundRect(ctx, x, y, w, h, 8, {
    fill: '#ffffff',
    stroke: focused ? BLACK : BORDER,
    lineWidth: focused ? 2.6 : 1.2,
  });
  wrapped(ctx, habit.name, x + 12, y + 11, 15, w - 24, 2, { weight: 'bold' });
  text(ctx, `${card.periodLabel} ${card.periodValue}`, x + 12, y + h - 38, 12, { color: GRAY });
  text(ctx, `${card.rightLabel} ${card.rightValue}`, x + 12, y + h - 21, 11, { color: GRAY, maxWidth: w - 24 });
}

/**
 * 首页：单卡，或按收藏数量自动排版的四宫格（1、2、3、4 张）。
 * @param {{layout: {mode: string, slots: object[]}, entries: object, today: string,
 *          cursor?: number, binarize?: boolean}} options
 */
export function renderHome(options) {
  const entries = options.entries ?? {};
  const today = options.today;
  const layout = options.layout ?? { mode: 'single', slots: [] };
  const cursor = Math.max(0, Number(options.cursor) || 0);
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });

  header(ctx, today);

  const habits = layout.slots ?? [];
  if (habits.length === 0) {
    const quadrant = layout.mode === 'quadrant';
    centered(ctx, quadrant ? '四宫格还没有习惯' : '首页还没有习惯', 116, 20, { weight: 'bold' });
    centered(ctx, quadrant ? '在网页里勾选 1～4 个习惯，' : '在网页里添加第一个习惯，', 152, 13, { color: GRAY });
    centered(ctx, quadrant ? '设备会按数量自动排版' : '设备上就会显示打卡卡片', 172, 13, { color: GRAY });
    footer(ctx, '上下键可切到别的应用');
    return exportPng(canvas, scale, { binarize: options.binarize === true });
  }

  if (layout.mode !== 'quadrant' || habits.length === 1) {
    singleCard(ctx, habits[0], entries, today);
    footer(ctx, layout.mode === 'quadrant'
      ? '确认打卡 · 长按上详情'
      : '确认打卡 · 长按上详情 · 长按下换习惯');
    return exportPng(canvas, scale, { binarize: options.binarize === true });
  }

  const gap = 10;
  const topY = 50;
  const bottomY = 154;
  const cardH = 94;
  const fullW = 368;
  const halfW = (fullW - gap) / 2;

  if (habits.length === 2) {
    wideCard(ctx, habits[0], entries, today, 16, topY, fullW, cardH, cursor === 0);
    wideCard(ctx, habits[1], entries, today, 16, bottomY, fullW, cardH, cursor === 1);
  } else if (habits.length === 3) {
    wideCard(ctx, habits[0], entries, today, 16, topY, fullW, cardH, cursor === 0);
    smallCard(ctx, habits[1], entries, today, 16, bottomY, halfW, cardH, cursor === 1);
    smallCard(ctx, habits[2], entries, today, 16 + halfW + gap, bottomY, halfW, cardH, cursor === 2);
  } else {
    smallCard(ctx, habits[0], entries, today, 16, topY, halfW, cardH, cursor === 0);
    smallCard(ctx, habits[1], entries, today, 16 + halfW + gap, topY, halfW, cardH, cursor === 1);
    smallCard(ctx, habits[2], entries, today, 16, bottomY, halfW, cardH, cursor === 2);
    smallCard(ctx, habits[3], entries, today, 16 + halfW + gap, bottomY, halfW, cardH, cursor === 3);
  }
  footer(ctx, '确认打卡 · 长按上详情 · 长按下换卡');

  return exportPng(canvas, scale, { binarize: options.binarize === true });
}

/**
 * 详情页：焦点习惯 + 它的 12 周历史。
 * @param {{habits: object[], entries: object, today: string, focus?: number,
 *          binarize?: boolean}} options
 */
export function renderHabit(options) {
  const habits = options.habits ?? [];
  const entries = options.entries ?? {};
  const today = options.today;
  const focus = Number.isInteger(options.focus) ? options.focus : 0;
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });

  header(ctx, today);

  if (habits.length === 0) {
    centered(ctx, '还没有习惯', 116, 20, { weight: 'bold' });
    centered(ctx, '在网页里添加第一个，', 152, 13, { color: GRAY });
    centered(ctx, '这里就会变成每天的打卡板', 172, 13, { color: GRAY });
    footer(ctx, '上下键可切到别的应用');
    return exportPng(canvas, scale, { binarize: options.binarize === true });
  }

  const done = todayDone(habits, entries, today);
  text(ctx, `今日 ${done} / ${habits.length}`, 16, 44, 13, { color: GRAY });
  const barX = 132;
  const barW = 252;
  roundRect(ctx, barX, 46, barW, 8, 4, { fill: '#ffffff', stroke: BORDER, lineWidth: 1 });
  if (habits.length) {
    const ratio = done / habits.length;
    if (ratio > 0) roundRect(ctx, barX, 46, barW * ratio, 8, 4, { fill: BLACK, stroke: null });
  }

  const habit = habits[Math.max(0, Math.min(focus, habits.length - 1))];
  const stats = habitStats(habit, entries, today);
  const freq = frequencyLabel(habit);
  const unit = streakUnit(habit);

  checkbox(ctx, 18, 68, 24, stats.doneToday);
  text(ctx, habit.name, 56, 64, 21, { weight: 'bold', maxWidth: 268 });
  const sub = stats.doneToday
    ? `今天已打卡 · 连续 ${stats.streak} ${unit} · 最佳 ${stats.best} ${unit}`
    : `连续 ${stats.streak} ${unit} · 最佳 ${stats.best} ${unit} · ${freq}`;
  text(ctx, sub, 56, 92, 11, { color: GRAY, maxWidth: 300 });

  if (habits.length > 1) {
    text(ctx, `${focus + 1} / ${habits.length}`, 384, 70, 11, { color: LIGHT, align: 'right' });
  }

  // ---- 历史格子：12 周 × 7 天 ----
  const cell = 14;
  const gap = 2;
  const step = cell + gap;
  const gridX = 28;
  const gridY = 132;
  const weeks = historyWeeks(habit, entries, today, 12);

  [0, 2, 4].forEach((row) => {
    text(ctx, WEEKDAYS[row].slice(1), 14, gridY + row * step + 1, 8, { color: LIGHT });
  });

  weeks.forEach((column, columnIndex) => {
    column.days.forEach((day, rowIndex) => {
      if (day.beforeStart) return;
      const x = gridX + columnIndex * step;
      const y = gridY + rowIndex * step;
      const isToday = day.key === today;
      if (day.future) {
        roundRect(ctx, x, y, cell, cell, 3, { fill: '#ffffff', stroke: IDLE_CELL, lineWidth: 1 });
        return;
      }
      if (day.done) {
        roundRect(ctx, x, y, cell, cell, 3, { fill: BLACK, stroke: BLACK, lineWidth: 1 });
        return;
      }
      roundRect(ctx, x, y, cell, cell, 3, {
        fill: '#ffffff',
        stroke: isToday ? BLACK : BORDER,
        lineWidth: isToday ? 1.8 : 1,
      });
    });
  });

  // 月份标记：列首落在 1～7 号时在列上方写月份
  weeks.forEach((column, columnIndex) => {
    const first = column.days[0];
    if (!first.beforeStart && first.key.slice(8) <= '07') {
      text(ctx, `${Number(first.key.slice(5, 7))}月`, gridX + columnIndex * step, gridY - 14, 8, { color: LIGHT });
    }
  });

  // ---- 右侧统计 ----
  const panelX = 238;
  text(ctx, `${Math.round(stats.score * 100)}%`, panelX, 128, 32, { weight: 'bold' });
  text(ctx, '得分', panelX + 2, 164, 10, { color: GRAY });
  line(ctx, panelX, 180, 384, 180, LIGHT, 1);

  const target = habitTarget(habit);
  const period = habitPeriod(habit);
  const rows = [
    [periodName(habit), `${stats.periodDone} / ${target}`],
    ['最佳连续', `${stats.best} ${unit}`],
    ['当前连续', `${stats.streak} ${unit}`],
    ['频率', period === 'week' && target >= 7 ? '每天' : freq],
  ];
  rows.forEach(([label, value], index) => {
    const y = 190 + index * 18;
    text(ctx, label, panelX, y, 9, { color: GRAY });
    text(ctx, value, 384, y - 1, 11, { align: 'right', weight: index === 0 ? 'bold' : 'normal' });
  });

  footer(ctx, '确认回单卡 · 长按下个 · 长按上四宫格');
  return exportPng(canvas, scale, { binarize: options.binarize === true });
}

export { WIDTH, HEIGHT };
