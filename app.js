'use strict';

/* ============================================================
   Moteur : fonctions pures, testables sous Node (tests.js)
   ============================================================ */
const Engine = (() => {
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = s => { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const mondayOf = s => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
  const weekday = s => parse(s).getDay();
  const shortDate = s => { const p = s.split('-'); return p[2] + '/' + p[1]; };
  const ZONES = ['z1', 'z2'];

  function emptyState(today) {
    return {
      v: 1,
      settings: { start: today, z1: '', z2: '', setup: false },
      checkins: {}, sessions: [], paliers: {}, lastChange: {}, typeChange: {},
      holds: {}, intros: {}, declined: {}, decisions: [], travel: {}, tests: {}, testSkip: ''
    };
  }

  function phaseOf(plan, date) {
    return (plan.phases || []).find(p => date >= p.from && date <= p.to) || null;
  }
  function frozen(plan, date) {
    const p = phaseOf(plan, date);
    return !!p && (p.kind === 'taper' || p.kind === 'trip' || p.kind === 'reprise');
  }
  // Semaine de ski : au moins 4 jours de séjour dans la semaine.
  function skiWeek(plan, monday) {
    let n = 0;
    for (let i = 0; i < 7; i++) { const p = phaseOf(plan, addDays(monday, i)); if (p && p.kind === 'trip') n++; }
    return n >= 4;
  }
  function visibleTypes(plan, date) {
    const p = phaseOf(plan, date);
    return Object.keys(plan.sessions).filter(T => !plan.sessions[T].phaseOnly || (p && p.kind === plan.sessions[T].phaseOnly));
  }

  function sessionName(plan, T) {
    const d = plan.sessions[T];
    if (d && d.phrase) return d.phrase;
    return 'séance ' + ((d && d.label) || T);
  }

  function normalize(s, today) {
    const base = emptyState(today);
    if (!s || typeof s !== 'object') return base;
    const out = Object.assign(base, s);
    out.settings = Object.assign(emptyState(today).settings, s.settings || {});
    ['checkins', 'paliers', 'lastChange', 'typeChange', 'holds', 'intros', 'declined', 'travel', 'tests'].forEach(k => {
      if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) out[k] = {};
    });
    if (!Array.isArray(out.sessions)) out.sessions = [];
    if (!Array.isArray(out.decisions)) out.decisions = [];
    return out;
  }

  function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Niveau habituel : médiane des points du matin des 7 jours avant `date`.
  function baseline(state, date, zone) {
    const vals = [];
    for (let i = 1; i <= 7; i++) {
      const c = state.checkins[addDays(date, -i)];
      if (c && typeof c[zone] === 'number') vals.push(c[zone]);
    }
    if (vals.length) return median(vals);
    const earlier = Object.keys(state.checkins).filter(k => k < date).sort();
    if (earlier.length) return state.checkins[earlier[earlier.length - 1]][zone];
    const own = state.checkins[date];
    return own ? own[zone] : null;
  }

  function sessionStatus(state, s) {
    if (s.painDuring === 'over' || s.technique === false || (s.effort || 0) >= 7) return 'ko';
    const d1 = addDays(s.date, 1);
    const c1 = state.checkins[d1];
    if (!c1) return 'pending';
    if (c1.doms === 'strong') return 'ko';
    for (const z of ZONES) {
      const b = baseline(state, d1, z);
      if (b !== null && c1[z] > b + 1) return 'ko';
    }
    const c2 = state.checkins[addDays(s.date, 2)];
    const c3 = state.checkins[addDays(s.date, 3)];
    if (c2 && c3 && c1.doms !== 'none' && c2.doms !== 'none' && c3.doms !== 'none') return 'ko';
    return 'ok';
  }

  function statusFor(state, s, today) {
    const st = sessionStatus(state, s);
    if (st === 'pending' && addDays(s.date, 1) < today) return 'unknown';
    return st;
  }

  function isActive(state, o) {
    if (o.intro && !state.intros[o.intro]) return false;
    if (o.until && state.intros[o.until]) return false;
    return true;
  }

  function sessionsOfType(state, type) {
    return state.sessions.filter(s => s.type === type).sort((a, b) => a.ts - b.ts);
  }

  function activeOptions(state, plan, type) {
    const def = plan.sessions[type];
    if (!def) return [];
    const out = [];
    def.slots.forEach(slot => {
      if (!isActive(state, slot)) return;
      slot.options.forEach(o => { if (isActive(state, o)) out.push(o); });
    });
    return out;
  }

  const palierOf = (state, o) => Math.min(state.paliers[o.key] || 0, o.ladder.length - 1);

  function sessionPlan(state, plan, type) {
    const def = plan.sessions[type];
    if (!def) return [];
    const done = state.sessions.filter(s => s.type === type).length;
    const items = [];
    def.slots.forEach(slot => {
      if (!isActive(state, slot)) return;
      const opts = slot.options.filter(o => isActive(state, o));
      if (!opts.length) return;
      const o = opts[done % opts.length];
      const ex = plan.exercises[o.ex] || { name: o.ex, cue: '' };
      const p = palierOf(state, o);
      items.push({
        slot: slot.id, key: o.key, ex: o.ex, name: ex.name, cue: ex.cue,
        dose: o.ladder[p], palier: p, max: o.ladder.length - 1,
        hold: o.holds ? o.holds[p] || null : null, alternates: opts.length > 1
      });
    });
    return items;
  }

  function holdActive(state, type, today) {
    return !!(state.holds[type] && today < state.holds[type]);
  }

  function upProposal(state, plan, type, today) {
    const def = plan.sessions[type];
    if (!def || def.noProgress || holdActive(state, type, today) || frozen(plan, today)) return null;
    const since = state.typeChange[type] || 0;
    const list = sessionsOfType(state, type).filter(s => s.ts > since);
    if (!list.length) return null;
    const known = list.map(s => statusFor(state, s, today)).filter(st => st !== 'unknown');
    if (known.length < def.stable) return null;
    if (!known.slice(-def.stable).every(st => st === 'ok')) return null;
    const last = list[list.length - 1];
    const dec = state.declined['up:' + type];
    if (dec && !(last.ts > dec)) return null;
    const hard = new Set(last.tooHard || []);
    const cands = [];
    activeOptions(state, plan, type).forEach((o, i) => {
      const p = palierOf(state, o);
      if (p < o.ladder.length - 1 && !hard.has(o.key)) {
        cands.push({ key: o.key, ex: o.ex, from: o.ladder[p], to: o.ladder[p + 1], last: state.lastChange[o.key] || 0, order: i });
      }
    });
    if (!cands.length) return null;
    cands.sort((a, b) => (a.last - b.last) || (a.order - b.order));
    return { id: 'up:' + type + ':' + last.id, kind: 'up', type, candidates: cands.slice(0, 2) };
  }

  // Clés à redescendre : la dernière montée de la séance (moins de 14 jours, pas encore annulée),
  // sinon tous les exercices au dessus de leur palier de départ.
  function downTarget(state, plan, type, today) {
    const activeKeys = activeOptions(state, plan, type).map(o => o.key);
    const recent = state.decisions
      .filter(d => d.kind === 'up' && d.accepted && d.type === type && !d.reverted && diffDays(d.date, today) <= 14)
      .sort((a, b) => a.ts - b.ts);
    const up = recent[recent.length - 1] || null;
    const pool = up ? (up.keys || []) : activeKeys;
    const keys = pool.filter(k => activeKeys.includes(k) && (state.paliers[k] || 0) > 0);
    return { keys, upTs: up ? up.ts : null, revert: !!up };
  }

  function flareProposals(state, plan, today) {
    const out = [];
    const decided = new Set(state.decisions.map(d => d.id));
    const L = z => state.settings[z] || (z === 'z1' ? 'zone 1' : 'zone 2');
    const add = (id, type, reason) => {
      if (decided.has(id)) return;
      const def = plan.sessions[type];
      if (def.noProgress || !def.slots.length) {
        out.push({ id, ids: [id], kind: 'info', text: reason + ' ' + (def.flareText || 'Garde tes doses habituelles sur les autres séances.') });
        return;
      }
      if (holdActive(state, type, today)) {
        out.push({ id, ids: [id], kind: 'info', text: reason + ' La dose de la ' + sessionName(plan, type) + ' est déjà réduite jusqu\'au ' + shortDate(state.holds[type]) + '. Si ça persiste, montre ce relevé à ton kiné.' });
        return;
      }
      const same = out.find(p => p.kind === 'down' && p.type === type);
      if (same) { same.ids.push(id); same.reasons.push(reason); return; }
      out.push({ id, ids: [id], kind: 'down', type, reasons: [reason], target: downTarget(state, plan, type, today) });
    };
    state.sessions.slice().sort((a, b) => a.ts - b.ts).forEach(s => {
      if (s.painDuring === 'over' && diffDays(s.date, today) <= 3 && plan.sessions[s.type]) {
        add('down:s:' + s.id, s.type, 'La douleur a monté de plus de 2 points pendant la ' + sessionName(plan, s.type) + ' du ' + shortDate(s.date) + '.');
      }
    });
    const c = state.checkins[today];
    if (c) {
      let reason = null;
      let before = today;
      if (c.doms === 'strong') reason = 'Courbatures fortes ce matin.';
      ZONES.forEach(z => {
        const b = baseline(state, today, z);
        if (b !== null && c[z] > b + 2) reason = 'Douleur au réveil (' + L(z) + ') supérieure de plus de 2 points à ton niveau habituel.';
      });
      if (!reason) {
        const c1 = state.checkins[addDays(today, -1)];
        const c2 = state.checkins[addDays(today, -2)];
        if (c.doms !== 'none' && c1 && c2 && c1.doms !== 'none' && c2.doms !== 'none') {
          reason = 'Courbatures depuis 3 matins de suite.';
          before = addDays(today, -2);
        }
      }
      if (reason) {
        const cands = state.sessions
          .filter(s => s.date < before && diffDays(s.date, before) <= 3 && plan.sessions[s.type])
          .sort((a, b) => a.ts - b.ts);
        const s = cands[cands.length - 1];
        if (s) add('down:' + today, s.type, reason);
        else if (!decided.has('info:' + today)) {
          out.push({ id: 'info:' + today, ids: ['info:' + today], kind: 'info',
            text: reason + ' Aucune séance dans les 3 jours précédents : la charge ne change pas. Si ça persiste, montre ce relevé à ton kiné.' });
        }
      }
    }
    return out;
  }

  function introProposal(state, plan, today) {
    if (frozen(plan, today)) return null;
    const intros = plan.intros || [];
    for (let i = 0; i < intros.length; i++) {
      const it = intros[i];
      if (state.intros[it.id]) continue;
      if (i > 0) {
        const prev = intros[i - 1];
        const acc = state.intros[prev.id];
        if (!acc) return null;
        const okSince = state.sessions.some(s => prev.types.includes(s.type) && s.ts > acc && statusFor(state, s, today) === 'ok');
        if (!okSince) return null;
      }
      const avail = it.date || addDays(mondayOf(state.settings.start), ((it.week || 1) - 1) * 7);
      if (today < avail) return null;
      for (const T of it.types) {
        if (holdActive(state, T, today)) return null;
        const list = sessionsOfType(state, T);
        if (!list.length || statusFor(state, list[list.length - 1], today) !== 'ok') return null;
      }
      const dec = state.declined['intro:' + it.id];
      if (dec && !state.sessions.some(s => it.types.includes(s.type) && s.ts > dec)) return null;
      return { id: 'intro:' + it.id, ids: ['intro:' + it.id], kind: 'intro', intro: it };
    }
    return null;
  }

  function milestoneCards(state, plan, today) {
    const decided = new Set(state.decisions.map(d => d.id));
    return (plan.milestones || [])
      .filter(m => today >= m.date && today <= m.until && !decided.has('ms:' + m.id))
      .map(m => ({ id: 'ms:' + m.id, ids: ['ms:' + m.id], kind: 'info', title: m.title, text: m.text }));
  }

  function monthlyCard(state, plan, today) {
    const n = Math.floor(diffDays(state.settings.start, today) / 28);
    if (n < 1) return [];
    const id = 'monthly:' + n;
    if (state.decisions.some(d => d.id === id)) return [];
    return [{ id, ids: [id], kind: 'info', title: 'Bilan du mois',
      text: 'Copie le résumé depuis l\'onglet Progrès, puis colle ce texte dans une conversation avec Claude pour ajuster le plan.' }];
  }

  function levelInfo(state, plan) {
    const total = Object.values(state.paliers).reduce((a, b) => a + Math.max(0, b || 0), 0);
    const lv = plan.levels || [{ name: '', min: 0 }];
    let i = 0;
    lv.forEach((l, k) => { if (total >= l.min) i = k; });
    const cur = lv[i];
    const next = lv[i + 1] || null;
    return { total, index: i, name: cur.name, color: cur.color, next, toNext: next ? next.min - total : 0 };
  }

  function nextBadge(state, plan, today) {
    const st = streakInfo(state, plan, today);
    const rewards = (state.settings.rewards || {});
    for (const n of [4, 8, 12]) {
      if (st.best >= n) continue;
      const left = n - st.streak;
      return { weeks: n, left, reward: rewards[n] || '' };
    }
    return null;
  }

  // Paliers gagnés, cumulés semaine par semaine, reconstitués depuis les décisions.
  function palierHistory(state, plan, today) {
    const seen = new Set();
    const deltas = [];
    state.decisions.forEach(d => {
      if (!d.accepted || !d.keys || (d.kind !== 'up' && d.kind !== 'down')) return;
      const k = d.kind + ':' + d.ts;
      if (seen.has(k)) return;
      seen.add(k);
      deltas.push({ date: d.date, n: (d.kind === 'up' ? 1 : -1) * d.keys.length });
    });
    const out = [];
    for (let m = mondayOf(state.settings.start); m <= mondayOf(today); m = addDays(m, 7)) {
      const end = addDays(m, 7);
      out.push({ week: m, total: Math.max(0, deltas.filter(x => x.date < end).reduce((a, x) => a + x.n, 0)) });
    }
    return out;
  }

  function weekHistory(state, plan, today) {
    const out = [];
    for (let m = mondayOf(state.settings.start); m <= mondayOf(today); m = addDays(m, 7)) {
      const c = weekCounts(state, plan, m);
      out.push({ week: m, sessions: c.short + c.long, z1: avgPain(state, m, 'z1'), z2: avgPain(state, m, 'z2'), ski: skiWeek(plan, m) });
    }
    return out;
  }

  function pendingDecisions(state, plan, today) {
    const out = flareProposals(state, plan, today).concat(milestoneCards(state, plan, today), monthlyCard(state, plan, today));
    const blocked = new Set(out.filter(p => p.kind === 'down').map(p => p.type));
    Object.keys(plan.sessions).forEach(T => {
      if (blocked.has(T)) return;
      const u = upProposal(state, plan, T, today);
      if (u) out.push(u);
    });
    if (!blocked.size) {
      const i = introProposal(state, plan, today);
      if (i) out.push(i);
    }
    return out;
  }

  function applyDown(state, plan, type, now, today) {
    const t = downTarget(state, plan, type, today);
    t.keys.forEach(k => { state.paliers[k] = (state.paliers[k] || 0) - 1; state.lastChange[k] = now; });
    if (t.upTs !== null) state.decisions.forEach(d => { if (d.kind === 'up' && d.ts === t.upTs && d.type === type) d.reverted = true; });
    state.typeChange[type] = now;
    state.holds[type] = addDays(today, 7);
    return t.keys;
  }

  function applyDecision(state, plan, prop, accept, selected, now, today) {
    const ids = prop.ids || [prop.id];
    const rec = (accepted, extra) => ids.forEach(id => state.decisions.push(Object.assign({ id, kind: prop.kind, date: today, ts: now, accepted }, extra || {})));
    if (prop.kind === 'up') {
      const keys = accept ? (selected || []).filter(k => prop.candidates.some(c => c.key === k)).slice(0, 2) : [];
      if (keys.length) {
        keys.forEach(k => { state.paliers[k] = (state.paliers[k] || 0) + 1; state.lastChange[k] = now; });
        state.typeChange[prop.type] = now;
        rec(true, { type: prop.type, keys });
      } else {
        state.declined['up:' + prop.type] = now;
        rec(false, { type: prop.type });
      }
    } else if (prop.kind === 'down') {
      if (accept) rec(true, { type: prop.type, keys: applyDown(state, plan, prop.type, now, today) });
      else rec(false, { type: prop.type });
    } else if (prop.kind === 'intro') {
      if (accept) {
        state.intros[prop.intro.id] = now;
        prop.intro.types.forEach(T => { state.typeChange[T] = now; });
      } else {
        state.declined['intro:' + prop.intro.id] = now;
      }
      rec(accept, { intro: prop.intro.id });
    } else {
      rec(true);
    }
    return state;
  }

  function kindOf(plan, type) { return plan.sessions[type] ? plan.sessions[type].kind : 'short'; }

  function weekCounts(state, plan, monday) {
    const end = addDays(monday, 7);
    const c = { short: 0, long: 0, byType: {}, sessions: [] };
    state.sessions.forEach(s => {
      if (s.date >= monday && s.date < end) {
        c[kindOf(plan, s.type)]++;
        c.byType[s.type] = (c.byType[s.type] || 0) + 1;
        c.sessions.push(s);
      }
    });
    return c;
  }

  function streakInfo(state, plan, today) {
    const start = mondayOf(state.settings.start);
    const cur = mondayOf(today);
    let streak = 0, best = 0, jokers = 0, used = 0, success = 0, full = 0, run = 0;
    for (let m = start; m <= cur; m = addDays(m, 7)) {
      const c = weekCounts(state, plan, m);
      const ok = (c.short >= plan.floor.short && c.long >= plan.floor.long) || skiWeek(plan, m);
      if (ok) {
        success++;
        if (c.short >= plan.full.short && c.long >= plan.full.long) full++;
        streak++; run++;
        if (run % 4 === 0 && jokers < 2) jokers++;
      } else if (m === cur) {
        // semaine en cours : ne casse pas la série
      } else if (jokers > 0) {
        jokers--; used++; run = 0;
      } else {
        streak = 0; run = 0;
      }
      best = Math.max(best, streak);
    }
    return { streak, best, jokers, used, successWeeks: success, fullWeeks: full, current: weekCounts(state, plan, cur) };
  }

  function points(state, plan, today) {
    let p = Object.keys(state.checkins).length * 2;
    state.sessions.forEach(s => {
      p += kindOf(plan, s.type) === 'long' ? 20 : 10;
      if (s.effort >= 3 && s.effort <= 6) p += 3;
    });
    const seen = new Set();
    state.decisions.forEach(d => {
      if (!d.accepted) return;
      const k = d.kind + ':' + d.ts;
      if (seen.has(k)) return;
      seen.add(k);
      if (d.kind === 'down') p += 15;
      else if (d.kind === 'up' || d.kind === 'intro') p += 5;
    });
    p += Object.keys(state.tests || {}).length * 5;
    const w = streakInfo(state, plan, today);
    return p + w.successWeeks * 25 + w.fullWeeks * 15;
  }

  function weekNumber(state, today) {
    return Math.max(1, Math.floor(diffDays(mondayOf(state.settings.start), today) / 7) + 1);
  }

  // Tableau de la semaine : les cases prévues, et la séance qui a rempli chacune.
  function weekBoard(state, plan, today) {
    const m = mondayOf(today);
    if (skiWeek(plan, m)) return { ski: true, slots: [], extra: [] };
    const slots = (state.travel[m] ? plan.floor.order : plan.targetOrder).map(t => ({ type: t, done: null }));
    const extra = [];
    weekCounts(state, plan, m).sessions.slice().sort((a, b) => a.ts - b.ts).forEach(s => {
      const def = plan.sessions[s.type];
      const kind = kindOf(plan, s.type);
      let i = slots.findIndex(x => !x.done && x.type === s.type);
      if (i < 0 && def && def.replaces) i = slots.findIndex(x => !x.done && x.type === def.replaces);
      if (i < 0) i = slots.findIndex(x => !x.done && kindOf(plan, x.type) === kind);
      if (i >= 0) slots[i].done = s; else extra.push(s);
    });
    return { ski: false, slots, extra };
  }

  function weekRemaining(state, plan, today) {
    const b = weekBoard(state, plan, today);
    return b.ski ? [] : b.slots.filter(x => !x.done).map(x => x.type);
  }

  // Une séance longue moins de 48 heures après la précédente ?
  function longTooSoon(state, plan, today) {
    const longs = state.sessions.filter(s => kindOf(plan, s.type) === 'long' && s.date <= today).sort((a, b) => a.ts - b.ts);
    const last = longs[longs.length - 1];
    return !!last && diffDays(last.date, today) < 2;
  }

  function suggestion(state, plan, today) {
    const ph = phaseOf(plan, today);
    if (ph && ph.kind === 'trip') {
      const ski = today >= (ph.skiFrom || ph.from) && today <= (ph.skiTo || ph.to);
      const done = state.sessions.some(s => s.date === today && s.type === ph.session);
      return ski && !done ? ph.session : null;
    }
    const rem = weekRemaining(state, plan, today);
    if (!rem.length) return null;
    const soon = longTooSoon(state, plan, today);
    const ok = t => kindOf(plan, t) !== 'long' || !soon;
    const tpl = state.travel[mondayOf(today)] ? null : plan.week[String(weekday(today))];
    if (tpl && rem.includes(tpl) && ok(tpl)) return tpl;
    return rem.find(ok) || null;
  }

  function testDue(state, plan, today) {
    if (!plan.tests || state.tests[today] || state.testSkip === today) return false;
    const dates = Object.keys(state.tests).sort();
    if (!dates.length) return state.sessions.length > 0;
    return diffDays(dates[dates.length - 1], today) >= plan.tests.every;
  }

  function badges(state, plan, today) {
    const st = streakInfo(state, plan, today);
    const acc = k => state.decisions.some(d => d.kind === k && d.accepted);
    return [
      { name: 'Premier palier monté', got: acc('up') },
      { name: 'Redescente acceptée', got: acc('down') },
      { name: 'Premier nouvel exercice', got: acc('intro') },
      { name: '4 semaines de suite', got: st.best >= 4, weeks: 4 },
      { name: '8 semaines de suite', got: st.best >= 8, weeks: 8 },
      { name: '12 semaines de suite', got: st.best >= 12, weeks: 12 },
      { name: 'Piste bleue', got: levelInfo(state, plan).index >= 1 },
      { name: 'Piste rouge', got: levelInfo(state, plan).index >= 2 },
      { name: 'Piste noire', got: levelInfo(state, plan).index >= 3 },
      { name: '30 points du matin', got: Object.keys(state.checkins).length >= 30 }
    ];
  }

  function avgPain(state, monday, zone) {
    const vals = [];
    for (let i = 0; i < 7; i++) { const c = state.checkins[addDays(monday, i)]; if (c) vals.push(c[zone]); }
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
  }

  function exportText(state, plan, today) {
    const from = addDays(today, -28);
    const L = z => state.settings[z] || z;
    const st = streakInfo(state, plan, today);
    const lines = [];
    lines.push('Export Socle du ' + today + ', plan v' + plan.version + ', semaine ' + weekNumber(state, today) + '.');
    lines.push('Zones suivies : z1 = ' + L('z1') + ', z2 = ' + L('z2') + '.');
    lines.push('Série : ' + st.streak + ' semaines (record ' + st.best + '), jokers ' + st.jokers + ', points ' + points(state, plan, today) + '.');
    lines.push('');
    lines.push('Points du matin (28 jours) : date, z1, z2, courbatures');
    Object.keys(state.checkins).filter(d => d >= from).sort().forEach(d => {
      const c = state.checkins[d];
      lines.push(d + ', ' + c.z1 + ', ' + c.z2 + ', ' + c.doms);
    });
    lines.push('');
    lines.push('Séances (28 jours) : date, type, effort, douleur pendant, technique, statut, trop dur');
    state.sessions.filter(s => s.date >= from).sort((a, b) => a.ts - b.ts).forEach(s => {
      lines.push([s.date, s.type, s.effort, s.painDuring, s.technique ? 'propre' : 'non', statusFor(state, s, today), (s.tooHard || []).join(' ') || 'aucun'].join(', '));
    });
    if (plan.tests) {
      lines.push('');
      lines.push('Tests : date, ' + plan.tests.items.map(it => it.key).join(', '));
      Object.keys(state.tests).sort().forEach(d => lines.push(d + ', ' + plan.tests.items.map(it => state.tests[d][it.key] == null ? 'vide' : state.tests[d][it.key]).join(', ')));
    }
    lines.push('');
    lines.push('Paliers actuels');
    Object.keys(plan.sessions).forEach(T => {
      activeOptions(state, plan, T).forEach(o => {
        const p = palierOf(state, o);
        lines.push(T + ', ' + (plan.exercises[o.ex] ? plan.exercises[o.ex].name : o.ex) + ' : ' + o.ladder[p] + ' (palier ' + (p + 1) + ' sur ' + o.ladder.length + ')');
      });
    });
    lines.push('');
    lines.push('Décisions (28 jours)');
    state.decisions.filter(d => d.date >= from).forEach(d => {
      lines.push(d.date + ', ' + d.kind + ', ' + (d.accepted ? 'acceptée' : 'refusée') +
        (d.type ? ', séance ' + d.type : '') + (d.keys && d.keys.length ? ', ' + d.keys.join(' ') : '') + (d.intro ? ', ' + d.intro : ''));
    });
    lines.push('');
    lines.push('JSON complet :');
    lines.push(JSON.stringify(state));
    return lines.join('\n');
  }

  return {
    ymd, parse, addDays, diffDays, mondayOf, weekday, shortDate, sessionName, weekRemaining, longTooSoon, testDue,
    phaseOf, frozen, skiWeek, visibleTypes, milestoneCards, weekBoard, monthlyCard, levelInfo, nextBadge, palierHistory, weekHistory,
    emptyState, normalize, baseline, sessionStatus, statusFor, sessionPlan, activeOptions,
    holdActive, upProposal, downTarget, flareProposals, introProposal, pendingDecisions,
    applyDecision, applyDown, weekCounts, streakInfo, points, weekNumber, suggestion,
    badges, avgPain, exportText
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;

/* ============================================================
   Interface
   ============================================================ */
if (typeof document !== 'undefined') {
  (function () {
    const E = Engine;
    const KEY = 'socle.v1';
    const DKEY = 'socle.draft';
    const root = document.getElementById('app');
    let plan = null;
    let state = null;
    let draft = null;
    const ui = { tab: 'today', override: null, ck: null, editCk: false, timer: null, sw: null, flash: '', celebrate: null, sel: {}, pending: [], manual: '', info: null, testVals: {} };

    const store = {
      get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
      del(k) { try { localStorage.removeItem(k); } catch (e) { /* rien */ } }
    };
    const today = () => E.ymd(new Date());
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    const pad2 = n => String(n).padStart(2, '0');
    const fmtN = n => Number(n).toLocaleString('fr-FR');
    const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const longDate = s => { const d = E.parse(s); return cap(JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()]); };
    const DOMS = { none: 'aucune', moderate: 'modérées', strong: 'fortes' };
    const PAIN = { stable: 'stable', small: '+1 à 2', over: 'plus de 2' };
    const STATUS = { ok: 'bien tolérée', ko: 'non tolérée', pending: 'en attente du point du matin', unknown: 'non évaluée' };
    const zl = z => state.settings[z] || (z === 'z1' ? 'Zone 1' : 'Zone 2');
    const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
    const secs = s => s >= 60 ? Math.round(s / 60) + ' min' : s + ' s';
    const sname = T => E.sessionName(plan, T);
    const lab = T => (plan.sessions[T] && plan.sessions[T].label) || T;
    const title = T => (plan.sessions[T] && (plan.sessions[T].title || plan.sessions[T].label)) || T;
    const joinEt = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' et ' + a[a.length - 1];
    const lvColor = c => (!c || c === '#111111') ? 'var(--ink)' : c;

    function load() {
      let s = null;
      try { s = JSON.parse(store.get(KEY)); } catch (e) { s = null; }
      state = E.normalize(s, today());
      try { draft = JSON.parse(store.get(DKEY)); } catch (e) { draft = null; }
    }
    function save() {
      if (!store.set(KEY, JSON.stringify(state))) ui.flash = 'Enregistrement impossible sur ce téléphone. Copie ta sauvegarde depuis Réglages.';
    }
    function saveDraft() { if (draft) store.set(DKEY, JSON.stringify(draft)); else store.del(DKEY); }

    function exName(key) { const o = optionOf(key); return o && plan.exercises[o.ex] ? plan.exercises[o.ex].name : key; }
    function optionOf(key) {
      for (const T of Object.keys(plan.sessions)) for (const slot of plan.sessions[T].slots) for (const o of slot.options) if (o.key === key) return o;
      return null;
    }

    function currentType(t) {
      const doneToday = state.sessions.some(s => s.date === t);
      if (ui.override) return ui.override;
      if (draft && draft.date === t && draft.type) return draft.type;
      if (doneToday) return null;
      return E.suggestion(state, plan, t);
    }

    /* ---------- Rendu ---------- */

    function render() {
      if (!plan) return;
      const t = today();
      let h = '';
      if (ui.celebrate) h += viewCelebrate();
      if (ui.flash) h += '<p class="flash" role="status">' + esc(ui.flash) + '</p>';
      if (ui.tab === 'today') h += viewToday(t);
      else if (ui.tab === 'progress') h += viewProgress(t);
      else h += viewSettings(t);
      if (ui.info) h += sheet(ui.info.ex, ui.info.key);
      root.innerHTML = h;
      document.body.classList.toggle('sheet-open', !!ui.info);
      document.querySelectorAll('.tabs button').forEach(b => {
        if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
      updateTimerLabel();
      updateStopwatch();
    }

    function viewCelebrate() {
      const c = ui.celebrate;
      return '<section class="celebrate" role="status"><p class="cel-title">' + esc(c.title) + '</p>' +
        (c.big ? '<p class="cel-big">' + esc(c.big) + '</p>' : '') +
        '<ul>' + c.lines.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul>' +
        '<button class="secondary" data-a="close-cel">Continuer</button></section>';
    }

    function viewSetup(t) {
      return '<header class="hero solo"><div><div class="big">Socle</div><div class="cap">La séance du jour, ta régularité et tes paliers. Tout reste sur ce téléphone.</div></div></header>' +
        '<section class="block"><h2>Pour commencer</h2>' +
        '<label class="field"><span>Première zone de douleur à suivre</span><input id="f-z1" type="text" placeholder="Par exemple : bas du dos" autocomplete="off"></label>' +
        '<label class="field"><span>Deuxième zone</span><input id="f-z2" type="text" placeholder="Par exemple : épaule" autocomplete="off"></label>' +
        '<label class="field"><span>Début du plan</span><input id="f-start" type="date" value="' + (E.weekday(t) === 0 ? E.addDays(t, 1) : E.mondayOf(t)) + '"></label>' +
        '<button class="primary" data-a="setup">Commencer</button></section>';
    }

    function levelHtml() {
      const lv = E.levelInfo(state, plan);
      const segs = plan.levels.map((l, i) => '<span class="lseg' + (i <= lv.index ? ' on' : '') + '" style="' +
        (i <= lv.index ? 'background:' + lvColor(l.color) + ';' : '') + 'border-color:' + lvColor(l.color) + '"></span>').join('');
      return '<div class="level"><span class="cap">Niveau</span><span class="lsegs" aria-hidden="true">' + segs + '</span>' +
        '<span class="lname" style="color:' + lvColor(lv.color) + '">' + esc(lv.name) + '</span></div>' +
        '<p class="cap">' + plural(lv.total, 'palier') + ' franchi' + (lv.total > 1 ? 's' : '') + (lv.next ? '. ' + cap(lv.next.name) + ' dans ' + plural(lv.toNext, 'palier') + '.' : '. Niveau maximum atteint.') + '</p>';
    }

    function boardHtml(t) {
      const b = E.weekBoard(state, plan, t);
      if (b.ski) return '<p class="board-ski">Semaine de ski : elle compte automatiquement pour ta série.</p>';
      const cur = currentType(t);
      let marked = false;
      const cells = b.slots.map(x => {
        const done = !!x.done;
        const now = !done && !marked && x.type === cur;
        if (now) marked = true;
        const l = done ? lab(x.done.type) : lab(x.type);
        return '<button class="cell' + (done ? ' done' : '') + (now ? ' now' : '') + '"' + (done ? ' disabled' : ' data-a="pick-type" data-t="' + x.type + '"') +
          ' aria-label="' + esc(title(done ? x.done.type : x.type)) + (done ? ', faite' : ', à faire') + '"><span class="bar"></span><span class="lbl">' + esc(l) + '</span></button>';
      }).join('');
      const doneN = b.slots.filter(x => x.done).length;
      return '<div class="board" style="grid-template-columns:repeat(' + b.slots.length + ',minmax(0,1fr))">' + cells + '</div>' +
        '<p class="cap">' + doneN + ' séance' + (doneN > 1 ? 's' : '') + ' sur ' + b.slots.length + ' cette semaine' +
        (state.travel[E.mondayOf(t)] ? ', semaine plancher' : '') + (b.extra.length ? ', plus ' + b.extra.length + ' en bonus' : '') + '. Touche une case pour choisir la séance.</p>';
    }

    function nextBadgeHtml(t) {
      const nb = E.nextBadge(state, plan, t);
      if (!nb) return '';
      const when = nb.left <= 1 ? 'en validant cette semaine' : 'dans ' + plural(nb.left, 'semaine');
      return '<p class="next">Prochain badge : ' + nb.weeks + ' semaines de suite, ' + when + '.' + (nb.reward ? ' Récompense : ' + esc(nb.reward) + '.' : '') + '</p>';
    }

    function viewToday(t) {
      if (!state.settings.setup) return viewSetup(t);
      const st = E.streakInfo(state, plan, t);
      let h = '<header class="hero"><div><div class="big">' + pad2(st.streak) + '</div><div class="cap">' + (st.streak > 1 ? 'semaines de suite' : 'semaine de suite') + '</div></div>' +
        '<div class="hero-r"><div class="cap">' + esc(longDate(t)) + '</div><div class="pts">' + fmtN(E.points(state, plan, t)) + ' <span>points</span></div></div></header>';
      h += boardHtml(t) + '<div class="rule"></div>' + levelHtml() + nextBadgeHtml(t);
      h += viewPhase(t) + viewCheckin(t) + viewTests(t) + viewDecisions(t) + viewSession(t) + viewTravel(t);
      return h;
    }

    function scale(action, field, val, from, to) {
      let h = '<div class="scale" role="group" style="grid-template-columns:repeat(' + (to - from + 1) + ',minmax(0,1fr))">';
      for (let i = from; i <= to; i++) h += '<button class="tick" data-a="' + action + '" data-f="' + field + '" data-v="' + i + '" aria-pressed="' + (val === i) + '">' + i + '</button>';
      return h + '</div>';
    }
    function seg(action, field, cur, opts) {
      return '<div class="seg">' + opts.map(([v, l]) => '<button data-a="' + action + '" data-f="' + field + '" data-v="' + v + '" aria-pressed="' + (cur === v) + '">' + esc(l) + '</button>').join('') + '</div>';
    }

    function viewPhase(t) {
      const ph = E.phaseOf(plan, t);
      if (!ph) return '';
      let h = '<section class="panel phase"><h2>' + esc(ph.title) + '</h2><p>' + esc(ph.text) + '</p>';
      if (ph.checklist && plan.skiChecklist) h += '<p class="label">Liste de contrôle ski</p><ul class="plain">' + plan.skiChecklist.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
      return h + '</section>';
    }

    function viewCheckin(t) {
      const c = state.checkins[t];
      if (c && !ui.editCk) {
        return '<p class="cap ck-done">Point du matin : ' + esc(zl('z1')) + ' ' + c.z1 + ', ' + esc(zl('z2')) + ' ' + c.z2 +
          ', courbatures ' + DOMS[c.doms] + '. <button class="link" data-a="edit-ck">Modifier</button></p>';
      }
      if (!ui.ck) ui.ck = c ? { z1: c.z1, z2: c.z2, doms: c.doms } : { z1: null, z2: null, doms: null };
      const k = ui.ck;
      return '<section class="panel"><h2>Point du matin</h2>' +
        '<p class="label">' + esc(zl('z1')) + ', douleur sur 10</p>' + scale('ck', 'z1', k.z1, 0, 10) +
        '<p class="label">' + esc(zl('z2')) + ', douleur sur 10</p>' + scale('ck', 'z2', k.z2, 0, 10) +
        '<p class="label">Courbatures</p>' + seg('ck', 'doms', k.doms, [['none', 'Aucune'], ['moderate', 'Modérées'], ['strong', 'Fortes']]) +
        '<button class="primary" data-a="save-ck">Enregistrer</button></section>';
    }

    function viewTests(t) {
      if (!E.testDue(state, plan, t)) return '';
      let h = '<section class="panel"><h2>Tests de la quinzaine</h2><p class="cap">' + esc(plan.tests.intro) + '</p>';
      plan.tests.items.forEach(it => {
        const v = ui.testVals[it.key];
        h += '<div class="test"><p class="test-name">' + esc(it.label) + '</p><p class="cap">' + esc(it.how) + '</p><div class="test-ctl">';
        if (it.kind === 'time') {
          const running = ui.sw && ui.sw.key === it.key;
          h += '<span class="test-val" id="tv-' + it.key + '">' + (v == null ? 0 : v) + ' s</span>' +
            '<button class="secondary" data-a="sw" data-k="' + it.key + '">' + (running ? 'Arrêter' : (v == null ? 'Démarrer le chrono' : 'Refaire')) + '</button>';
        } else {
          h += '<button class="secondary sq" data-a="cnt" data-k="' + it.key + '" data-d="-1" aria-label="Retirer une répétition"><span class="glyph minus"></span></button>' +
            '<span class="test-val">' + (v == null ? 0 : v) + '</span>' +
            '<button class="secondary sq" data-a="cnt" data-k="' + it.key + '" data-d="1" aria-label="Ajouter une répétition"><span class="glyph plus"></span></button>';
        }
        h += '</div></div>';
      });
      return h + '<div class="actions"><button class="primary" data-a="save-tests">Enregistrer les tests</button><button class="secondary" data-a="skip-tests">Plus tard</button></div></section>';
    }

    function viewDecisions(t) {
      ui.pending = E.pendingDecisions(state, plan, t);
      return ui.pending.map((p, i) => {
        if (p.kind === 'up' && !ui.sel[p.id]) ui.sel[p.id] = [p.candidates[0].key];
        return card(p, i);
      }).join('');
    }

    function card(p, i) {
      const btns = (ok, no) => '<div class="actions"><button class="primary" data-a="decide" data-i="' + i + '" data-ok="1">' + ok + '</button>' +
        (no ? '<button class="secondary" data-a="decide" data-i="' + i + '" data-ok="0">' + no + '</button>' : '') + '</div>';
      if (p.kind === 'up') {
        const sel = ui.sel[p.id] || [];
        return '<section class="panel go"><h2>Palier suivant en ' + esc(sname(p.type)) + ' ?</h2>' +
          '<p>Tes ' + plan.sessions[p.type].stable + ' dernières séances sont bien tolérées. Choisis un exercice, deux au maximum.</p>' +
          '<div class="choices">' + p.candidates.map(c => '<button class="choice" data-a="pick" data-i="' + i + '" data-k="' + esc(c.key) + '" aria-pressed="' + sel.includes(c.key) + '">' +
            '<span class="choice-name">' + esc(exName(c.key)) + '</span><span class="choice-dose">' + esc(c.from) + ', puis ' + esc(c.to) + '</span></button>').join('') + '</div>' +
          btns('Franchir le palier', 'Pas maintenant') + '</section>';
      }
      if (p.kind === 'down') {
        let what;
        if (p.target.keys.length) {
          what = (p.target.revert ? 'Retour sur la dernière montée : ' : 'Retour au palier précédent : ') + p.target.keys.map(k => {
            const o = optionOf(k); const cur = Math.min(state.paliers[k] || 0, o.ladder.length - 1);
            return exName(k) + ' (' + o.ladder[cur - 1] + ')';
          }).join(', ') + '.';
        } else {
          what = 'Tu es déjà au palier de départ : fais les ' + sname(p.type).replace('séance', 'séances').replace('routine', 'routines') + ' à moitié pendant une semaine.';
        }
        return '<section class="panel warn"><h2>Redescendre en ' + esc(sname(p.type)) + ' ?</h2>' +
          p.reasons.map(r => '<p>' + esc(r) + '</p>').join('') + '<p>' + esc(what) + ' Aucune montée proposée sur cette séance pendant une semaine.</p>' +
          btns('Redescendre', 'Garder la dose') + '</section>';
      }
      if (p.kind === 'intro') {
        return '<section class="panel go"><h2>Nouvel exercice : ' + esc(p.intro.name.toLowerCase()) + '</h2><p>' + esc(p.intro.text) + '</p>' +
          btns('Ajouter l\'exercice', 'Pas maintenant') + '</section>';
      }
      return '<section class="panel' + (p.title ? '' : ' warn') + '">' + (p.title ? '<h2>' + esc(p.title) + '</h2>' : '') + '<p>' + esc(p.text) + '</p>' + btns('Compris', null) + '</section>';
    }

    function viewTravel(t) {
      const on = !!state.travel[E.mondayOf(t)];
      return '<section class="block travel"><div class="row"><span id="lbl-travel">Semaine de voyage</span>' +
        '<button class="switch" role="switch" aria-labelledby="lbl-travel" data-a="travel" aria-checked="' + on + '"></button></div>' +
        '<p class="cap">' + (on ? 'Semaine plancher : ' + joinEt(plan.floor.order.map(title)) + ', toutes faisables en chambre d\'hôtel.' : 'À activer si tu es en déplacement ou débordé : la semaine passe à 4 séances.') + '</p></section>';
    }

    function viewSession(t) {
      const doneToday = state.sessions.filter(s => s.date === t);
      const sug = E.suggestion(state, plan, t);
      const type = currentType(t);
      let h = '<section class="block session">';
      h += doneToday.map(s => '<p class="done-line">' + esc(cap(sname(s.type))) + ' faite aujourd\'hui. Effort ' + s.effort + ', douleur ' + PAIN[s.painDuring] +
        '. <button class="link" data-a="undo" data-id="' + esc(s.id) + '">Annuler</button></p>').join('');
      if (!type) {
        if (!doneToday.length) h += '<div class="sess-head"><h2>Repos</h2></div><p class="cap">' + (E.weekRemaining(state, plan, t).length ? 'Rien de prévu aujourd\'hui. Touche une case de la semaine si tu veux quand même avancer.' : 'Semaine complète. Une séance de plus reste possible.') + '</p>';
        return h + otherRow(null, t) + '</section>';
      }
      const def = plan.sessions[type];
      if (!draft || draft.date !== t || draft.type !== type) {
        draft = { date: t, type, done: [], hard: [], effort: null, pain: null, tech: true };
        saveDraft();
      }
      const items = E.sessionPlan(state, plan, type);
      h += '<div class="sess-head"><h2>' + esc(title(type)) + '</h2><span class="cap">' + def.minutes + ' min</span></div>' +
        '<p class="cap">' + esc(def.name) + '.' + (sug && sug !== type ? ' Suggestion du jour : ' + esc(sname(sug)) + '.' : '') + '</p>';
      const ph = E.phaseOf(plan, t);
      if (ph && ph.note && type !== 'S') h += '<p class="note">' + esc(ph.note) + '</p>';
      if (def.kind === 'long' && E.longTooSoon(state, plan, t)) h += '<p class="note">Ta dernière séance longue date de moins de 48 heures. Si tu peux, attends demain.</p>';
      if (E.holdActive(state, type, t)) h += '<p class="note">Dose réduite jusqu\'au ' + E.shortDate(state.holds[type]) + ' : aucune montée proposée sur cette séance d\'ici là.</p>';
      h += items.length ? '<ol class="exlist">' + items.map(exItem).join('') + '</ol>' : '<p class="cap">Séance menée par ton instructeur ou ton kiné. Note l\'effort et la douleur à la fin.</p>';
      const wk = E.weekNumber(state, t);
      h += '<div class="finish"><p class="label">Effort ressenti, sur 10. ' + (wk <= 2 ? 'Vise 4 à 5.' : 'Garde de la marge.') + '</p>' + scale('dr', 'effort', draft.effort, 1, 10) +
        '<p class="label">Douleur pendant la séance</p>' + seg('dr', 'pain', draft.pain, [['stable', 'Stable'], ['small', '+1 à 2'], ['over', 'Plus de 2']]) +
        '<p class="label">Technique propre</p>' + seg('dr', 'tech', draft.tech ? '1' : '0', [['1', 'Oui'], ['0', 'Non']]) +
        '<button class="primary" data-a="finish">Terminer la séance</button></div>';
      return h + otherRow(type, t) + '</section>';
    }

    function otherRow(type, t) {
      return '<div class="other"><p class="label">Autre séance</p><div class="chips">' + E.visibleTypes(plan, t).map(T =>
        '<button class="chip" data-a="pick-type" data-t="' + T + '" aria-pressed="' + (T === type) + '">' + esc(title(T)) + '</button>').join('') + '</div></div>';
    }

    function rungs(p, max) {
      let h = '<span class="rungs" aria-hidden="true">';
      for (let i = max; i >= 0; i--) h += '<i' + (i <= p ? ' class="on"' : '') + '></i>';
      return h + '</span>';
    }

    function exItem(it) {
      const done = draft.done.includes(it.key);
      const hard = draft.hard.includes(it.key);
      const running = ui.timer && ui.timer.key === it.key;
      let h = '<li class="ex' + (done ? ' done' : '') + '">';
      h += '<button class="check" data-a="done" data-k="' + esc(it.key) + '" aria-pressed="' + done + '" aria-label="' + esc(it.name) + ' fait"></button>';
      h += '<div class="ex-body"><button class="ex-name" data-a="info" data-ex="' + esc(it.ex) + '" data-k="' + esc(it.key) + '"><span>' + esc(it.name) + '</span><span class="chev" aria-hidden="true">›</span></button>';
      if (it.alternates) h += '<p class="cap">En alternance d\'une séance à l\'autre</p>';
      h += '<p class="dose">' + esc(it.dose) + '</p>';
      if (it.max > 0) h += '<p class="palier">Palier ' + (it.palier + 1) + ' sur ' + (it.max + 1) + '</p>';
      h += '<div class="ex-tools">';
      if (it.hold) h += '<button class="tool' + (running ? ' running' : '') + '" id="tm-' + esc(it.key) + '" data-a="timer" data-k="' + esc(it.key) + '" data-s="' + it.hold + '">Minuteur ' + secs(it.hold) + '</button>';
      h += '<button class="tool" data-a="hard" data-k="' + esc(it.key) + '" aria-pressed="' + hard + '">Trop dur</button></div></div>';
      h += it.max > 0 ? '<span class="ladder" role="img" aria-label="Palier ' + (it.palier + 1) + ' sur ' + (it.max + 1) + '">' + rungs(it.palier, it.max) + '</span>' : '<span></span>';
      return h + '</li>';
    }

    function sheet(exId, key) {
      const ex = plan.exercises[exId];
      if (!ex) return '';
      const d = ex.detail || {};
      const o = key ? optionOf(key) : null;
      const p = o ? Math.min(state.paliers[o.key] || 0, o.ladder.length - 1) : 0;
      const sec = (h3, body) => body ? '<h3>' + h3 + '</h3>' + body : '';
      const para = x => x ? '<p>' + esc(x) + '</p>' : '';
      const list = (tag, a) => a && a.length ? '<' + tag + '>' + a.map(x => '<li>' + esc(x) + '</li>').join('') + '</' + tag + '>' : '';
      let h = '<div class="sheet-backdrop" data-a="close-info"></div><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">';
      h += '<div class="sheet-head"><h2 id="sheet-title" tabindex="-1">' + esc(ex.name) + '</h2><button class="secondary" data-a="close-info">Fermer</button></div>';
      if (o) {
        h += '<p class="dose">' + esc(o.ladder[p]) + '</p>';
        if (o.ladder.length > 1) h += '<p class="palier">Palier ' + (p + 1) + ' sur ' + o.ladder.length + (p < o.ladder.length - 1 ? '. Prochain palier : ' + esc(o.ladder[p + 1]) + '.' : '. Plafond atteint.') + '</p>';
      }
      h += para(d.why) + sec('L\'essentiel', para(ex.cue)) + sec('Position de départ', para(d.setup)) + sec('Mouvement', list('ol', d.steps)) +
        sec('Respiration', para(d.breath)) + sec('Ce que tu dois sentir', para(d.feel)) + sec('À éviter', list('ul', d.avoid)) + sec('Plus facile', para(d.easier));
      if (d.video) {
        h += '<h3>Vidéos</h3><p><a class="link" href="https://www.youtube.com/results?search_query=' + encodeURIComponent(d.video) + '" target="_blank" rel="noopener">Chercher « ' + esc(d.video) + ' » sur YouTube</a></p>' +
          (plan.videoNote ? '<p class="cap">' + esc(plan.videoNote) + '</p>' : '');
      }
      return h + '</section>';
    }

    /* ---------- Progrès ---------- */

    const W = 340, H = 150, PL = 26, PR = 8, PT = 10, PB = 22;
    function xAt(i, n) { return n <= 1 ? PL + (W - PL - PR) / 2 : PL + i * (W - PL - PR) / (n - 1); }
    function yAt(v, max) { return PT + (H - PT - PB) * (1 - v / max); }
    function axis(labels, max, ticks) {
      let g = '';
      ticks.forEach(v => { const y = yAt(v, max); g += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y + '" y2="' + y + '" class="grid"/><text x="' + (PL - 6) + '" y="' + (y + 4) + '" class="ax" text-anchor="end">' + v + '</text>'; });
      const n = labels.length; const step = Math.max(1, Math.ceil(n / 6));
      labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) g += '<text x="' + xAt(i, n) + '" y="' + (H - 6) + '" class="ax" text-anchor="middle">' + l + '</text>'; });
      return g;
    }
    function svg(inner, label) { return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="' + esc(label) + '">' + inner + '</svg>'; }

    function chartSessions(hist) {
      const n = hist.length, max = 8, bw = Math.min(22, (W - PL - PR) / Math.max(n, 1) * 0.6);
      let g = axis(hist.map(h => E.shortDate(h.week)), max, [0, 4, 6, 8]);
      g += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + yAt(6, max) + '" y2="' + yAt(6, max) + '" class="ref"/>';
      hist.forEach((h, i) => {
        const v = h.ski ? 6 : Math.min(max, h.sessions);
        const y = yAt(v, max);
        g += '<rect x="' + (xAt(i, n) - bw / 2) + '" y="' + y + '" width="' + bw + '" height="' + (yAt(0, max) - y) + '" class="' + (h.ski ? 'bar-ski' : (h.sessions >= 4 ? 'bar' : 'bar-low')) + '"/>';
      });
      return svg(g, 'Séances par semaine');
    }
    function chartPain(hist) {
      const n = hist.length, max = 10;
      let g = axis(hist.map(h => E.shortDate(h.week)), max, [0, 5, 10]);
      ['z1', 'z2'].forEach(z => {
        const pts = hist.map((h, i) => h[z] == null ? null : [xAt(i, n), yAt(h[z], max)]).filter(Boolean);
        if (pts.length > 1) g += '<polyline points="' + pts.map(p => p.join(',')).join(' ') + '" class="' + (z === 'z1' ? 'line1' : 'line2') + '"/>';
        pts.forEach(p => { g += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" class="' + (z === 'z1' ? 'dot1' : 'dot2') + '"/>'; });
      });
      return svg(g, 'Douleur moyenne au réveil par semaine');
    }
    function chartPaliers(hist) {
      const n = hist.length;
      const top = Math.max(plan.levels[plan.levels.length - 1].min + 5, ...hist.map(h => h.total + 2));
      let g = axis(hist.map(h => E.shortDate(h.week)), top, [0]);
      plan.levels.slice(1).forEach(l => {
        const y = yAt(l.min, top);
        g += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y + '" y2="' + y + '" style="stroke:' + lvColor(l.color) + '" class="lvline"/><text x="' + (PL - 6) + '" y="' + (y + 4) + '" class="ax" text-anchor="end">' + l.min + '</text>';
      });
      const pts = hist.map((h, i) => [xAt(i, n), yAt(h.total, top)]);
      if (pts.length > 1) g += '<polyline points="' + pts.map(p => p.join(',')).join(' ') + '" class="line1"/>';
      pts.forEach(p => { g += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" class="dot1"/>'; });
      return svg(g, 'Paliers franchis, cumulés');
    }
    function spark(vals, max) {
      const w = 120, h = 32;
      if (!vals.length) return '';
      const x = i => vals.length === 1 ? w / 2 : 4 + i * (w - 8) / (vals.length - 1);
      const y = v => 4 + (h - 8) * (1 - v / max);
      return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="spark" aria-hidden="true">' +
        (vals.length > 1 ? '<polyline points="' + vals.map((v, i) => x(i) + ',' + y(v)).join(' ') + '" class="line1"/>' : '') +
        vals.map((v, i) => '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="2.5" class="dot1"/>').join('') + '</svg>';
    }

    function viewProgress(t) {
      if (!state.settings.setup) return viewSetup(t);
      const st = E.streakInfo(state, plan, t);
      const hist = E.weekHistory(state, plan, t).slice(-12);
      const ph = E.palierHistory(state, plan, t).slice(-12);
      let h = '<header class="hero"><div><div class="big">' + pad2(st.streak) + '</div><div class="cap">' + (st.streak > 1 ? 'semaines de suite' : 'semaine de suite') + ', record ' + st.best + '</div></div>' +
        '<div class="hero-r"><div class="cap">' + (st.jokers ? plural(st.jokers, 'joker') + ' en réserve' : 'Aucun joker') + '</div><div class="pts">' + fmtN(E.points(state, plan, t)) + ' <span>points</span></div></div></header>';
      h += levelHtml() + nextBadgeHtml(t);
      h += '<p class="cap">Une semaine compte dès 4 séances. Chaque bloc de 4 semaines réussies donne un joker, 2 au maximum, qui protège la série une semaine ratée.</p>';
      h += '<section class="block"><h2>Régularité</h2>' + chartSessions(hist) + '<p class="cap">Séances par semaine. La ligne marque l\'objectif de 6 ; en gris clair, les semaines sous 4. Les semaines de ski comptent comme complètes.</p></section>';
      h += '<section class="block"><h2>Douleur au réveil</h2>' + (hist.some(x => x.z1 != null) ? chartPain(hist) : '<p class="cap">La courbe apparaît après tes premiers points du matin.</p>') +
        '<p class="legend"><span class="k1"></span>' + esc(zl('z1')) + '<span class="k2"></span>' + esc(zl('z2')) + '</p><p class="cap">Moyenne de la semaine, sur 10.</p></section>';
      h += '<section class="block"><h2>Paliers franchis</h2>' + chartPaliers(ph) + '<p class="cap">Cumul semaine par semaine. Les lignes de couleur marquent les niveaux : bleue, rouge, noire.</p></section>';
      const td = Object.keys(state.tests).sort();
      h += '<section class="block"><h2>Tests de la quinzaine</h2>';
      if (!td.length) h += '<p class="cap">Premiers tests proposés après ta première séance, puis toutes les deux semaines.</p>';
      else h += '<ul class="plain tests">' + plan.tests.items.map(it => {
        const vals = td.map(d => state.tests[d][it.key]).filter(v => v != null);
        const unit = it.kind === 'time' ? ' s' : '';
        return '<li><div><div class="test-name">' + esc(it.label) + '</div><div class="cap">' + (vals.length ? (vals.length > 1 ? vals[0] + unit + ' au départ, ' + vals[vals.length - 1] + unit + ' au dernier test' : vals[0] + unit) : 'pas encore mesuré') + '</div></div>' + spark(vals, it.max) + '</li>';
      }).join('') + '</ul>';
      h += '</section>';
      h += '<section class="block"><h2>Badges</h2><ul class="badges">' + E.badges(state, plan, t).map(b => {
        const r = b.weeks && state.settings.rewards && state.settings.rewards[b.weeks];
        return '<li class="' + (b.got ? 'got' : '') + '">' + esc(b.name) + (r ? ', ' + esc(r) : '') + (b.got ? '' : '<span class="sr"> (pas encore)</span>') + '</li>';
      }).join('') + '</ul></section>';
      const recent = state.sessions.slice().sort((a, b) => b.ts - a.ts).slice(0, 8);
      h += '<section class="block"><h2>Dernières séances</h2>' + (recent.length ? '<ul class="plain">' + recent.map(s =>
        '<li><span class="when">' + E.shortDate(s.date) + ', ' + esc(title(s.type)) + '</span> effort ' + s.effort + ', douleur ' + PAIN[s.painDuring] + ', ' + STATUS[E.statusFor(state, s, t)] + '.</li>').join('') + '</ul>'
        : '<p class="cap">La première séance se lance depuis Aujourd\'hui.</p>') + '</section>';
      h += '<section class="block"><h2>Paliers actuels</h2>';
      Object.keys(plan.sessions).forEach(T => {
        const opts = E.activeOptions(state, plan, T).filter(o => o.ladder.length > 1);
        if (!opts.length || plan.sessions[T].noProgress) return;
        h += '<p class="label">' + esc(title(T)) + '</p><ul class="plain">' + opts.map(o => {
          const p = Math.min(state.paliers[o.key] || 0, o.ladder.length - 1);
          return '<li class="pal"><button class="inline-ex" data-a="info" data-ex="' + esc(o.ex) + '" data-k="' + esc(o.key) + '">' + esc(plan.exercises[o.ex].name) + '</button><span class="cap">' + esc(o.ladder[p]) + ', palier ' + (p + 1) + ' sur ' + o.ladder.length + '</span></li>';
        }).join('') + '</ul>';
      });
      h += '</section><section class="block"><h2>Bilan avec Claude</h2><p class="cap">Une fois par mois, ou quand une décision de l\'app te surprend : copie le résumé de tes 28 derniers jours, puis colle ce texte dans une conversation avec Claude.</p>' +
        '<button class="primary" data-a="copy-claude">Copier le résumé</button>' + manualBox() + '</section>';
      return h;
    }

    function manualBox() {
      return ui.manual ? '<label class="field"><span>Texte à copier à la main</span><textarea readonly id="f-manual">' + esc(ui.manual) + '</textarea></label>' : '';
    }

    function viewSettings(t) {
      const s = state.settings;
      const r = s.rewards || {};
      let h = '<header class="hero solo"><div><div class="big small">Réglages</div><div class="cap">Plan version ' + plan.version + '</div></div></header>';
      if (s.setup) {
        h += '<section class="block"><h2>Suivi</h2>' +
          '<label class="field"><span>Première zone de douleur</span><input id="f-z1" type="text" value="' + esc(s.z1) + '" autocomplete="off"></label>' +
          '<label class="field"><span>Deuxième zone</span><input id="f-z2" type="text" value="' + esc(s.z2) + '" autocomplete="off"></label>' +
          '<label class="field"><span>Début du plan</span><input id="f-start" type="date" value="' + esc(s.start) + '"></label>' +
          '<h2 class="sub">Récompenses</h2><p class="cap">' + esc(plan.badgeRewardsHint) + '</p>' +
          [4, 8, 12].map(n => '<label class="field"><span>À ' + n + ' semaines de suite</span><input id="f-r' + n + '" type="text" value="' + esc(r[n] || '') + '" autocomplete="off"></label>').join('') +
          '<button class="primary" data-a="save-settings">Enregistrer les réglages</button></section>';
      }
      h += '<section class="block"><h2>Sauvegarde</h2><p class="cap">Tes données ne quittent jamais ce téléphone. Avant chaque mise à jour de l\'app, copie une sauvegarde, puis colle ce texte dans Notes.</p>' +
        '<button class="secondary wide" data-a="copy-backup">Copier la sauvegarde</button>' + manualBox() +
        '<label class="field"><span>Restaurer une sauvegarde</span><textarea id="f-import" placeholder="Colle ici une sauvegarde ou un résumé copié depuis l\'app"></textarea></label>' +
        '<button class="secondary wide" data-a="import">Restaurer</button></section>';
      h += '<section class="block"><h2>Règles</h2><ul class="plain">' + plan.rules.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></section>';
      h += '<section class="block"><h2>Comment l\'app décide</h2><ul class="plain">' + plan.logic.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></section>';
      h += '<section class="block"><h2>Tout effacer</h2><p class="cap">Supprime toutes les séances, les points du matin et les paliers de ce téléphone.</p>' +
        '<button class="secondary wide danger" data-a="reset">Tout effacer</button></section>';
      return h;
    }

    /* ---------- Sons, minuteur, chrono ---------- */

    let actx = null;
    function audio() {
      try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { actx = null; }
    }
    function beep() {
      if (!actx) return;
      try {
        const o = actx.createOscillator(); const g = actx.createGain();
        o.frequency.value = 880; g.gain.value = 0.2; o.connect(g); g.connect(actx.destination);
        const n = actx.currentTime; o.start(n); o.stop(n + 0.25);
      } catch (e) { /* rien */ }
    }
    let tickId = null;
    function stopTimer() { clearInterval(tickId); tickId = null; ui.timer = null; }
    function updateTimerLabel() {
      if (!ui.timer) return;
      const left = Math.ceil((ui.timer.end - Date.now()) / 1000);
      const b = document.getElementById('tm-' + ui.timer.key);
      if (left <= 0) {
        const k = ui.timer.key; const s = ui.timer.secs;
        stopTimer(); beep(); setTimeout(beep, 350);
        const b2 = document.getElementById('tm-' + k);
        if (b2) { b2.textContent = 'Terminé. Relancer ' + secs(s); b2.classList.remove('running'); }
        return;
      }
      if (b) { b.textContent = 'Arrêter, ' + left + ' s'; b.classList.add('running'); }
    }
    let swId = null;
    function testItem(key) { return plan.tests.items.find(x => x.key === key); }
    function stopStopwatch(fill) {
      if (!ui.sw) return;
      const it = testItem(ui.sw.key);
      const v = Math.min(it.max, Math.floor((Date.now() - ui.sw.start) / 1000));
      if (fill) ui.testVals[ui.sw.key] = v;
      clearInterval(swId); swId = null; ui.sw = null;
    }
    function updateStopwatch() {
      if (!ui.sw) return;
      const it = testItem(ui.sw.key);
      const v = Math.floor((Date.now() - ui.sw.start) / 1000);
      if (v >= it.max) { stopStopwatch(true); beep(); setTimeout(beep, 350); render(); return; }
      const el = document.getElementById('tv-' + ui.sw.key);
      if (el) el.textContent = v + ' s';
    }

    /* ---------- Actions ---------- */

    function copyText(text, okMsg) {
      ui.manual = '';
      const fallback = () => { ui.manual = text; ui.flash = 'Copie automatique impossible : le texte apparaît plus bas, à sélectionner à la main.'; render(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => { ui.flash = okMsg; render(); }, fallback);
      else fallback();
    }

    function earnedBadges() { return new Set(E.badges(state, plan, today()).filter(b => b.got).map(b => b.name)); }

    const actions = {
      setup() {
        state.settings.z1 = document.getElementById('f-z1').value.trim();
        state.settings.z2 = document.getElementById('f-z2').value.trim();
        const st = document.getElementById('f-start').value;
        state.settings.start = /^\d{4}-\d{2}-\d{2}$/.test(st) ? st : today();
        state.settings.setup = true;
        save();
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      },
      'save-settings'() {
        actions.setup();
        const r = {};
        [4, 8, 12].forEach(n => { const v = document.getElementById('f-r' + n).value.trim(); if (v) r[n] = v; });
        state.settings.rewards = r;
        save();
        ui.flash = 'Réglages enregistrés.';
      },
      'close-cel'() { ui.celebrate = null; },
      'edit-ck'() { ui.editCk = true; ui.ck = null; },
      ck(d) {
        if (!ui.ck) ui.ck = { z1: null, z2: null, doms: null };
        ui.ck[d.f] = d.f === 'doms' ? d.v : Number(d.v);
      },
      'save-ck'() {
        const k = ui.ck;
        if (!k || k.z1 === null || k.z2 === null || !k.doms) { ui.flash = 'Choisis les deux douleurs et les courbatures avant d\'enregistrer.'; return; }
        const t = today();
        const first = !state.checkins[t];
        state.checkins[t] = { z1: k.z1, z2: k.z2, doms: k.doms, ts: Date.now() };
        save();
        ui.ck = null; ui.editCk = false;
        ui.flash = first ? 'Point du matin enregistré. +2 points.' : 'Point du matin modifié.';
      },
      info(d) { ui.info = { ex: d.ex, key: d.k || null }; return 'sheet'; },
      'close-info'() { ui.info = null; },
      sw(d) {
        if (ui.sw && ui.sw.key === d.k) { stopStopwatch(true); return; }
        stopStopwatch(false);
        audio();
        ui.sw = { key: d.k, start: Date.now() };
        delete ui.testVals[d.k];
        swId = setInterval(updateStopwatch, 250);
      },
      cnt(d) {
        const it = testItem(d.k);
        ui.testVals[d.k] = Math.max(0, Math.min(it.max, (ui.testVals[d.k] || 0) + Number(d.d)));
      },
      'save-tests'() {
        if (ui.sw) stopStopwatch(true);
        const vals = {};
        plan.tests.items.forEach(it => { if (ui.testVals[it.key] != null) vals[it.key] = ui.testVals[it.key]; });
        if (!Object.keys(vals).length) { ui.flash = 'Fais au moins un test avant d\'enregistrer.'; return; }
        state.tests[today()] = vals;
        ui.testVals = {};
        save();
        ui.celebrate = { title: 'Tests enregistrés', lines: ['+5 points', 'Tes courbes sont dans l\'onglet Progrès.'] };
      },
      'skip-tests'() { if (ui.sw) stopStopwatch(false); state.testSkip = today(); save(); ui.flash = 'Les tests te seront proposés demain.'; },
      pick(d) {
        const p = ui.pending[Number(d.i)];
        if (!p) return;
        const sel = ui.sel[p.id] || [];
        const i = sel.indexOf(d.k);
        if (i >= 0) sel.splice(i, 1);
        else if (sel.length >= 2) ui.flash = 'Deux exercices au maximum.';
        else sel.push(d.k);
        ui.sel[p.id] = sel;
      },
      decide(d) {
        const p = ui.pending[Number(d.i)];
        if (!p) return;
        const ok = d.ok === '1';
        if (ok && p.kind === 'up' && !(ui.sel[p.id] || []).length) { ui.flash = 'Choisis au moins un exercice, ou touche Pas maintenant.'; return; }
        const lvBefore = E.levelInfo(state, plan).index;
        E.applyDecision(state, plan, p, ok, ui.sel[p.id], Date.now(), today());
        save();
        if (!ok) {
          ui.flash = p.kind === 'up' ? 'Noté. La proposition reviendra après ta prochaine ' + sname(p.type) + '.'
            : p.kind === 'intro' ? 'Noté. La proposition reviendra après ta prochaine séance concernée.'
            : p.kind === 'down' ? 'Noté. La dose reste la même.' : '';
          return;
        }
        if (p.kind === 'up') {
          const keys = (ui.sel[p.id] || []);
          const lv = E.levelInfo(state, plan);
          const lines = keys.map(k => { const o = optionOf(k); return exName(k) + ' : ' + o.ladder[Math.min(state.paliers[k], o.ladder.length - 1)]; });
          lines.push('+5 points');
          ui.celebrate = { title: keys.length > 1 ? 'Paliers franchis' : 'Palier franchi', big: lv.index > lvBefore ? 'Nouveau niveau : ' + lv.name : '', lines };
        } else if (p.kind === 'down') {
          ui.celebrate = { title: 'Règle respectée', lines: ['Dose réduite pendant une semaine.', 'Écouter ton corps rapporte plus que forcer : +15 points.'] };
        } else if (p.kind === 'intro') {
          ui.celebrate = { title: 'Nouvel exercice', lines: [p.intro.name + ' ajouté.', '+5 points'] };
        }
      },
      travel() {
        const m = E.mondayOf(today());
        if (state.travel[m]) delete state.travel[m]; else state.travel[m] = true;
        ui.override = null;
        save();
      },
      'pick-type'(d) {
        const hasProgress = draft && draft.date === today() && draft.type !== d.t && (draft.done.length || draft.effort !== null || draft.pain);
        if (hasProgress && !window.confirm('Changer de séance ? Ce que tu as coché sera perdu.')) return;
        ui.override = d.t;
        stopTimer();
        return 'scroll-session';
      },
      done(d) { const i = draft.done.indexOf(d.k); if (i >= 0) draft.done.splice(i, 1); else draft.done.push(d.k); saveDraft(); },
      hard(d) { const i = draft.hard.indexOf(d.k); if (i >= 0) draft.hard.splice(i, 1); else draft.hard.push(d.k); saveDraft(); },
      dr(d) {
        if (d.f === 'effort') draft.effort = Number(d.v);
        else if (d.f === 'pain') draft.pain = d.v;
        else if (d.f === 'tech') draft.tech = d.v === '1';
        saveDraft();
      },
      timer(d) {
        if (ui.timer && ui.timer.key === d.k) { stopTimer(); return; }
        audio(); stopTimer();
        const s = Number(d.s);
        ui.timer = { key: d.k, secs: s, end: Date.now() + s * 1000 };
        tickId = setInterval(updateTimerLabel, 250);
      },
      finish() {
        if (!draft || draft.effort === null || !draft.pain) { ui.flash = 'Indique l\'effort et la douleur pendant la séance avant de terminer.'; return; }
        const t = today();
        const before = E.points(state, plan, t);
        const m = E.mondayOf(t);
        const stBefore = E.streakInfo(state, plan, t).current;
        const floorBefore = stBefore.short >= plan.floor.short && stBefore.long >= plan.floor.long;
        const fullBefore = stBefore.short >= plan.full.short && stBefore.long >= plan.full.long;
        const items = E.sessionPlan(state, plan, draft.type);
        const s = {
          id: 's' + Date.now().toString(36), date: t, ts: Date.now(), type: draft.type,
          items: items.map(it => ({ key: it.key, palier: it.palier })),
          done: draft.done.slice(), tooHard: draft.hard.slice(),
          effort: draft.effort, painDuring: draft.pain, technique: draft.tech !== false
        };
        state.sessions.push(s);
        save();
        const c = E.weekCounts(state, plan, m);
        const lines = [];
        lines.push('+' + (plan.sessions[s.type].kind === 'long' ? 20 : 10) + ' points pour la séance');
        if (s.effort >= 3 && s.effort <= 6) lines.push('+3 points : dosage respecté');
        if (!floorBefore && c.short >= plan.floor.short && c.long >= plan.floor.long) lines.push('Semaine validée pour ta série : +25 points');
        if (!fullBefore && c.short >= plan.full.short && c.long >= plan.full.long) lines.push('Semaine complète : +15 points');
        const b = E.weekBoard(state, plan, t);
        if (!b.ski) { const n = b.slots.filter(x => x.done).length; lines.push(plural(n, 'séance') + ' sur ' + b.slots.length + ' cette semaine'); }
        if (s.painDuring === 'over') lines.push('La douleur a trop monté : une proposition de redescente t\'attend plus bas.');
        else lines.push('Demain matin, le point du matin dira si elle est bien tolérée.');
        ui.celebrate = { title: cap(sname(s.type)) + ' terminée', big: '+' + (E.points(state, plan, t) - before) + ' points', lines };
        draft = null; saveDraft(); ui.override = null; stopTimer();
        window.scrollTo(0, 0);
      },
      undo(d) {
        const s = state.sessions.find(x => x.id === d.id);
        if (!s || !window.confirm('Annuler la ' + sname(s.type) + ' d\'aujourd\'hui ?')) return;
        state.sessions = state.sessions.filter(x => x.id !== d.id);
        save();
        ui.flash = 'Séance annulée.';
      },
      'copy-claude'() { copyText(E.exportText(state, plan, today()), 'Résumé copié. Colle le texte dans une conversation avec Claude.'); return 'async'; },
      'copy-backup'() { copyText(JSON.stringify(state), 'Sauvegarde copiée.'); return 'async'; },
      import() {
        const txt = (document.getElementById('f-import').value || '').trim();
        const j = txt.charAt(0) === '{' ? txt : txt.slice(txt.indexOf('\n{') + 1);
        let s = null;
        try { s = JSON.parse(j); } catch (e) { s = null; }
        if (!s || !s.settings || !Array.isArray(s.sessions)) { ui.flash = 'Restauration impossible : le texte collé ne contient pas de sauvegarde Socle.'; return; }
        if (!window.confirm('Remplacer toutes les données de ce téléphone par cette sauvegarde ?')) return;
        state = E.normalize(s, today());
        draft = null; saveDraft(); save();
        ui.flash = 'Sauvegarde restaurée : ' + plural(state.sessions.length, 'séance') + '.';
      },
      reset() {
        if (!window.confirm('Tout effacer sur ce téléphone ?')) return;
        if (!window.confirm('Confirme : cette action ne peut pas être annulée.')) return;
        store.del(KEY); draft = null; saveDraft();
        state = E.emptyState(today());
        ui.tab = 'today';
        ui.flash = 'Données effacées.';
      }
    };

    root.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b || b.disabled) return;
      const fn = actions[b.dataset.a];
      if (!fn) return;
      ui.flash = '';
      const keepCel = ['close-cel', 'info', 'close-info', 'sw', 'cnt', 'timer', 'done', 'hard', 'dr', 'ck'].includes(b.dataset.a);
      if (!keepCel) ui.celebrate = null;
      const before = earnedBadges();
      const r = fn(b.dataset);
      const after = earnedBadges();
      const fresh = [...after].filter(x => !before.has(x));
      if (fresh.length) {
        const rw = state.settings.rewards || {};
        const extra = fresh.map(n => { const m = n.match(/^(\d+) semaines/); return 'Nouveau badge : ' + n + (m && rw[m[1]] ? '. Récompense : ' + rw[m[1]] : ''); });
        if (ui.celebrate) ui.celebrate.lines = ui.celebrate.lines.concat(extra);
        else ui.celebrate = { title: 'Nouveau badge', lines: extra };
      }
      if (r !== 'async') render();
      if (r === 'sheet') {
        const sh = document.querySelector('.sheet'); if (sh) sh.scrollTop = 0;
        const ti = document.getElementById('sheet-title'); if (ti) ti.focus();
      }
      if (r === 'scroll-session') { const s = document.querySelector('.session'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'start' }); }
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.info) { ui.info = null; render(); } });
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      ui.tab = b.dataset.tab; ui.flash = ''; ui.manual = ''; ui.celebrate = null;
      render(); window.scrollTo(0, 0);
    }));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });

    load();
    fetch('plan.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(p => { plan = p; render(); })
      .catch(() => { root.innerHTML = '<section class="block"><h1>Plan introuvable</h1><p>Le fichier du plan n\'a pas pu être chargé. Ouvre l\'app une fois avec une connexion internet ; ensuite, elle fonctionne hors ligne.</p></section>'; });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
}
