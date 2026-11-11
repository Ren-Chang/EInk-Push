// 习惯打卡（Loop Habit Tracker 的墨水屏版）。
//
// 设备只有三个键，而且：
//   · 上/下「短按」属于全局的切换应用，应用不能抢
//   · 确认「长按」协议里根本不存在（confirm+long 是非法组合，固件也不上报）
//   · 上/下「长按」是合法的，全局切换只认短按，所以留给应用内部导航
// 交互分成两种首页 + 一层详情：
//   首页（单卡 或 四宫格）
//     确认短按 → 直接打卡/取消当前卡（两种模式一致）
//     长按上   → 进入当前卡详情
//     长按下   → 换下一张卡（单卡翻全部习惯，四宫格翻收藏卡）
//   详情页（12 周历史 + 得分）
//     确认短按 → 切回单卡，并把当前习惯作为单卡
//     长按下   → 切到下一个习惯的详情
//     长按上   → 切到四宫格首页（四宫格为空时留在单卡）
// 模式切换也能在设备上完成，不必回网页。
// 按键是全局事件，所以只有「租约」内才响应：推卡后 65 秒，或网页接管期间；
// 别的应用推图时 onScreenTaken 立刻归还按键，避免背单词时按确认误打卡。
//
// 四宫格选哪几个、频率（周/月/季度 + 目标次数）仍在网页里设置。

import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureFont } from '../shared/canvas.js';
import { httpStatusOf } from '../../src/errors.js';
import { formatFor } from '../../src/image.js';
import {
  createHabit, dateKey, isDateKey, pickFocus, todayDone, toggleEntry,
  removeHabitEntries, clampFrequency, clampPeriod, clampTarget, habitStats,
  monthDayLabel, homeLayout,
} from './state.js';
import { loadStateSync, saveState, VERSION } from './store.js';
import { renderHabit, renderHome } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEY_LEASE_MS = 65 * 1000;
const HOME_MODES = ['single', 'quadrant'];

function badRequest(res, message) {
  res.status(400).json({ ok: false, error: message });
}

export default {
  id: 'habit',
  name: '习惯',
  description: 'Loop 式习惯打卡：首页收藏或四宫格，确认进详情打卡，长按上下选卡片',

  create(ctx) {
    ensureFont({ fontsDir: ctx.fontsDir });

    const dir = path.join(ctx.dataDir, 'habit');
    const state = loadStateSync(dir);
    const runtime = {
      activeUntil: 0,
      lastPush: null,
      lastError: null,
      view: 'home',
      detailId: null,
    };
    let chain = Promise.resolve();
    let saveChain = Promise.resolve();
    // 别的应用抢屏的次数：本次推送开始时记一个值，推送结束时如果变了，
    // 说明中途屏幕已经被别人接管，不能再把按键租约要回来。
    let screenTaken = 0;
    const unsubscribers = [];

    function run(task) {
      const next = chain.then(task);
      chain = next.then(
        () => {},
        (err) => {
          runtime.lastError = String(err?.message || err);
          ctx.log(`习惯：${runtime.lastError}`);
        },
      );
      return next;
    }

    /** 串行落盘，避免两次按键的写入交错 */
    function persist() {
      const snapshot = {
        version: VERSION,
        habits: state.habits,
        entries: state.entries,
        selectedId: state.selectedId,
        quadrantIds: state.quadrantIds,
        homeMode: state.homeMode,
        createdAt: state.createdAt,
      };
      saveChain = saveChain
        .then(() => saveState(dir, snapshot))
        .catch((err) => ctx.log(`习惯：保存失败 ${String(err?.message || err)}`));
      return saveChain;
    }

    function today() {
      return dateKey(new Date());
    }

    function layout() {
      return homeLayout(state.habits, {
        homeMode: state.homeMode,
        quadrantIds: state.quadrantIds,
        selectedId: state.selectedId,
      });
    }

    function pinnedHabits() {
      return homeLayout(state.habits, {
        homeMode: 'quadrant',
        quadrantIds: state.quadrantIds,
      }).slots;
    }

    function habitById(id) {
      return state.habits.find((habit) => habit.id === id) ?? null;
    }

    /** 确保 selectedId 落在当前模式的可见集合里；单卡模式初始停在第一个未完成项 */
    function ensureSelection(date = today()) {
      if (!state.habits.length) {
        state.selectedId = null;
        return;
      }
      if (state.homeMode === 'quadrant') {
        const featured = layout().slots.filter(Boolean);
        if (!featured.some((habit) => habit.id === state.selectedId)) {
          state.selectedId = featured[0]?.id ?? null;
        }
        if (!state.selectedId) {
          const index = pickFocus(state.habits, state.entries, date, null);
          state.selectedId = state.habits[Math.max(0, index)]?.id ?? state.habits[0].id;
        }
        return;
      }
      if (!habitById(state.selectedId)) {
        const index = pickFocus(state.habits, state.entries, date, null);
        state.selectedId = state.habits[Math.max(0, index)]?.id ?? state.habits[0].id;
      }
    }

    function featuredHabits() {
      ensureSelection();
      return layout().slots.filter(Boolean);
    }

    /** 首页光标：单卡模式恒为 0；四宫格模式定位当前选中项 */
    function homeCursorIndex() {
      const featured = featuredHabits();
      if (!featured.length) return -1;
      let index = featured.findIndex((habit) => habit.id === state.selectedId);
      if (index < 0) {
        index = 0;
        state.selectedId = featured[0].id;
      }
      return index;
    }

    function homeCursorHabit() {
      const index = homeCursorIndex();
      return index >= 0 ? featuredHabits()[index] : null;
    }

    function detailHabit() {
      if (runtime.detailId) {
        const habit = habitById(runtime.detailId);
        if (habit) return habit;
      }
      return homeCursorHabit();
    }

    function isActive() {
      return runtime.activeUntil > Date.now();
    }

    function arm() {
      runtime.activeUntil = Date.now() + KEY_LEASE_MS;
    }

    function disarm() {
      runtime.activeUntil = 0;
    }

    function moveHomeFocus(delta) {
      ensureSelection();
      // 单卡模式翻全部习惯；四宫格模式只在选中的四张卡里翻
      const pool = state.homeMode === 'quadrant' ? featuredHabits() : state.habits;
      if (pool.length <= 1) return false;
      let index = pool.findIndex((habit) => habit.id === state.selectedId);
      if (index < 0) index = 0;
      const next = (index + delta + pool.length) % pool.length;
      state.selectedId = pool[next].id;
      return true;
    }

    /** 详情页长按下：按全局习惯顺序切到下一个（和旧版长按换习惯一致） */
    function moveDetailNext() {
      if (state.habits.length <= 1) return false;
      const current = detailHabit();
      let index = state.habits.findIndex((habit) => habit.id === current?.id);
      if (index < 0) index = 0;
      const next = (index + 1) % state.habits.length;
      state.selectedId = state.habits[next].id;
      runtime.detailId = state.habits[next].id;
      return true;
    }

    function currentPng(options = {}) {
      const date = options.date ?? today();
      const view = options.view ?? runtime.view;
      if (view === 'detail') {
        const habit = options.habitId ? habitById(options.habitId) : detailHabit();
        if (habit) {
          const focus = state.habits.findIndex((item) => item.id === habit.id);
          return renderHabit({
            habits: state.habits,
            entries: state.entries,
            today: date,
            focus: Math.max(0, focus),
            binarize: options.binarize,
          });
        }
      }
      return renderHome({
        layout: layout(),
        entries: state.entries,
        today: date,
        cursor: Math.max(0, homeCursorIndex()),
        binarize: options.binarize,
      });
    }

    async function pushPng(png) {
      const token = screenTaken;
      const client = await ctx.getClient();
      const started = Date.now();
      await client.show(png, formatFor(client));
      if (token === screenTaken) arm();
      runtime.lastPush = { at: new Date().toISOString(), ms: Date.now() - started };
      runtime.lastError = null;
      return runtime.lastPush;
    }

    async function pushHome() {
      runtime.view = 'home';
      runtime.detailId = null;
      return pushPng(currentPng({ view: 'home' }));
    }

    async function pushDetail() {
      const habit = detailHabit();
      if (!habit) return pushHome();
      runtime.view = 'detail';
      runtime.detailId = habit.id;
      return pushPng(currentPng({ view: 'detail' }));
    }

    /** 服务层切换到本应用时调用：总是从首页开始 */
    async function pushCurrent() {
      runtime.view = 'home';
      runtime.detailId = null;
      return pushPng(currentPng({ view: 'home' }));
    }

    async function pushCurrentView() {
      return runtime.view === 'detail' ? pushDetail() : pushHome();
    }

    /** 打卡/取消某一天；设备按键只能改今天，历史日期由网页改 */
    function toggle(habitId, date = today()) {
      const habit = habitById(habitId);
      if (!habit) throw new Error('习惯不存在');
      if (!isDateKey(date)) throw new Error('日期格式应为 YYYY-MM-DD');
      if (date > today()) throw new Error('不能给未来日期打卡');
      const before = (state.entries[habit.id]?.[date] ?? 0) > 0;
      state.entries = toggleEntry(state.entries, habit.id, date);
      state.selectedId = habit.id;
      persist();
      return { habitId: habit.id, date, done: !before };
    }

    function openDetail(habit) {
      if (!habit) return;
      runtime.view = 'detail';
      runtime.detailId = habit.id;
      state.selectedId = habit.id;
      run(() => pushDetail()).catch(() => {});
    }

    /**
     * 确认短按：
     * - 首页（单卡或四宫格）：直接打卡/取消当前卡；
     * - 详情页：切回单卡模式，并把当前习惯作为单卡。
     */
    function handleConfirm() {
      const date = today();
      if (runtime.view === 'detail') {
        const habit = detailHabit();
        if (!habit) {
          runtime.view = 'home';
          runtime.detailId = null;
          run(() => pushHome()).catch(() => {});
          return;
        }
        state.homeMode = 'single';
        state.selectedId = habit.id;
        runtime.view = 'home';
        runtime.detailId = null;
        persist();
        run(() => pushHome()).catch(() => {});
        return;
      }

      const habit = homeCursorHabit();
      if (!habit) return;
      toggle(habit.id, date);
      run(() => pushHome()).catch(() => {});
    }

    /**
     * 长按上下：
     * - 首页：长按上进详情，长按下换下一张卡（单卡翻全部习惯，四宫格翻收藏卡）；
     * - 详情页：长按下翻下一个习惯，长按上切到四宫格首页；四宫格为空时留在单卡。
     */
    function handleVerticalLong(delta) {
      if (runtime.view === 'detail') {
        if (delta < 0) {
          state.homeMode = pinnedHabits().length ? 'quadrant' : 'single';
          ensureSelection();
          runtime.view = 'home';
          runtime.detailId = null;
          persist();
          run(() => pushHome()).catch(() => {});
          return;
        }
        if (moveDetailNext()) run(() => pushDetail()).catch(() => {});
        return;
      }

      if (delta < 0) {
        openDetail(homeCursorHabit());
        return;
      }
      if (moveHomeFocus(1)) run(() => pushHome()).catch(() => {});
    }

    const router = express.Router();
    router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

    function statePayload(date = today()) {
      const home = layout();
      return {
        ok: true,
        today: date,
        label: monthDayLabel(date),
        active: isActive(),
        view: runtime.view,
        detailId: runtime.detailId,
        doneToday: todayDone(state.habits, state.entries, date),
        focusId: homeCursorHabit()?.id ?? null,
        homeMode: state.homeMode,
        quadrantIds: state.quadrantIds,
        homeIds: home.slots.filter(Boolean).map((habit) => habit.id),
        habits: state.habits.map((habit) => ({
          ...habit,
          stats: habitStats(habit, state.entries, date),
        })),
        lastPush: runtime.lastPush,
        lastError: runtime.lastError,
      };
    }

    router.get('/api/state', (req, res) => {
      res.json(statePayload());
    });

    router.post('/api/habits', async (req, res) => {
      try {
        const habit = createHabit({
          name: req.body?.name,
          period: req.body?.period,
          target: req.body?.target,
          freq: req.body?.freq,
        });
        habit.order = state.habits.length;
        state.habits.push(habit);
        if (!state.selectedId) state.selectedId = habit.id;
        await persist();
        res.json({ ok: true, habit, ...statePayload() });
      } catch (err) {
        badRequest(res, String(err.message || err));
      }
    });

    router.put('/api/habits/:id', async (req, res) => {
      const habit = state.habits.find((item) => item.id === req.params.id);
      if (!habit) return res.status(404).json({ ok: false, error: '习惯不存在' });
      try {
        if (req.body?.name !== undefined) {
          const name = String(req.body.name).trim();
          if (!name) throw new Error('习惯名称不能为空');
          if (name.length > 40) throw new Error('习惯名称最多 40 个字符');
          habit.name = name;
        }
        if (req.body?.period !== undefined) habit.period = clampPeriod(req.body.period);
        if (req.body?.target !== undefined) {
          habit.target = clampTarget(req.body.target);
        } else if (req.body?.freq !== undefined) {
          habit.period = 'week';
          habit.target = clampFrequency(req.body.freq);
        }
        if (habit.target === undefined) habit.target = habit.freq ?? 7;
        habit.freq = habit.period === 'week' ? Math.min(7, habit.target) : habit.target;
        await persist();
        res.json({ ok: true, habit, ...statePayload() });
      } catch (err) {
        badRequest(res, String(err.message || err));
      }
    });

    router.delete('/api/habits/:id', async (req, res) => {
      const index = state.habits.findIndex((item) => item.id === req.params.id);
      if (index < 0) return res.status(404).json({ ok: false, error: '习惯不存在' });
      const [removed] = state.habits.splice(index, 1);
      state.entries = removeHabitEntries(state.entries, removed.id);
      if (state.selectedId === removed.id) state.selectedId = state.habits[0]?.id ?? null;
      state.quadrantIds = state.quadrantIds.filter((id) => id !== removed.id);
      await persist();
      res.json({ ok: true, removed: removed.id, ...statePayload() });
    });

    /** 首页显示：单卡 或 四宫格（网页专用；只有四宫格里的习惯需要收藏） */
    router.put('/api/home', async (req, res) => {
      const body = req.body ?? {};
      const ids = new Set(state.habits.map((habit) => habit.id));
      const quadrantIds = [];
      for (const id of Array.isArray(body.quadrantIds) ? body.quadrantIds : []) {
        if (typeof id !== 'string' || !ids.has(id) || quadrantIds.includes(id)) continue;
        quadrantIds.push(id);
        if (quadrantIds.length >= 4) break;
      }
      state.homeMode = HOME_MODES.includes(body.mode) ? body.mode : 'single';
      state.quadrantIds = quadrantIds;
      if (state.homeMode === 'quadrant') {
        if (!quadrantIds.includes(state.selectedId)) state.selectedId = quadrantIds[0] ?? null;
      }
      ensureSelection();
      await persist();
      res.json({ ok: true, ...statePayload() });
    });

    router.post('/api/toggle', async (req, res) => {
      try {
        const result = toggle(String(req.body?.id ?? ''), req.body?.date);
        const shouldPush = req.body?.push !== false;
        const pushed = shouldPush
          ? await run(() => pushCurrentView()).then(() => true).catch(() => false)
          : false;
        res.json({ ok: true, ...result, pushed, ...statePayload() });
      } catch (err) {
        badRequest(res, String(err.message || err));
      }
    });

    /** 网页打开/关闭时接管或交还确认键（与今天吃什么一致的租约约定） */
    router.post('/api/arm', (req, res) => {
      const active = req.body?.active !== false;
      if (active) arm();
      else disarm();
      res.json({ ok: true, active });
    });

    router.post('/api/push', async (req, res) => {
      try {
        const lastPush = await run(() => pushCurrentView());
        res.json({ ok: true, lastPush, ...statePayload() });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.get('/api/preview.png', (req, res) => {
      try {
        const date = typeof req.query.date === 'string' && isDateKey(req.query.date) ? req.query.date : undefined;
        const view = req.query.view === 'detail' ? 'detail' : req.query.view === 'home' ? 'home' : runtime.view;
        const habitId = typeof req.query.id === 'string' ? req.query.id : undefined;
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(currentPng({ date, view, habitId }));
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    // ---- 设备按键 ----
    unsubscribers.push(ctx.on('event', (event) => {
      if (event?.type !== 'key') return;
      if (!isActive()) return;

      // 每次按键都续期：连续快速操作时，上一次推图还没完成也不能让租约断掉
      arm();

      if (event.key === 'confirm' && event.action === 'short') {
        handleConfirm();
        return;
      }

      if ((event.key === 'up' || event.key === 'down') && event.action === 'long') {
        handleVerticalLong(event.key === 'up' ? -1 : 1);
      }
    }));

    const app = {
      router,
      async start() {
        const home = layout();
        ctx.log(`习惯已就绪：${state.habits.length} 个习惯，首页 ${home.slots.filter(Boolean).length} 张卡，今日 ${todayDone(state.habits, state.entries, today())}/${state.habits.length}`);
      },
      stop() {
        for (const off of unsubscribers.splice(0)) {
          try { off(); } catch { /* 已解绑 */ }
        }
      },
      status() {
        const date = today();
        return {
          habits: state.habits.length,
          doneToday: todayDone(state.habits, state.entries, date),
          focus: homeCursorHabit()?.name ?? null,
          view: runtime.view,
          active: isActive(),
          lastPush: runtime.lastPush,
          lastError: runtime.lastError,
        };
      },
      pushCurrent,
      onScreenTaken() {
        screenTaken += 1;
        disarm();
      },
    };

    return app;
  },
};
