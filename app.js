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
    const l = (plan.sessions[T] && plan.sessions[T].label) || T;
    return 'séance ' + (l.length === 1 ? l : l.toLowerCase());
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

  function pendingDecisions(state, plan, today) {
    const out = flareProposals(state, plan, today).concat(milestoneCards(state, plan, today));
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

  // Ce qui reste à faire cette semaine, dans l'ordre de référence.
  function weekRemaining(state, plan, today) {
    const m = mondayOf(today);
    if (skiWeek(plan, m)) return [];
    const target = (state.travel[m] ? plan.floor.order : plan.targetOrder).slice();
    weekCounts(state, plan, m).sessions.slice().sort((a, b) => a.ts - b.ts).forEach(s => {
      const def = plan.sessions[s.type];
      const kind = kindOf(plan, s.type);
      let i = target.indexOf(s.type);
      if (i < 0 && def && def.replaces) i = target.indexOf(def.replaces);
      if (i < 0) i = target.findIndex(t => kindOf(plan, t) === kind);
      if (i >= 0) target.splice(i, 1);
    });
    return target;
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
      { name: '4 semaines de suite', got: st.best >= 4 },
      { name: '8 semaines de suite', got: st.best >= 8 },
      { name: '12 semaines de suite', got: st.best >= 12 },
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
    phaseOf, frozen, skiWeek, visibleTypes, milestoneCards,
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
    const ui = { tab: 'today', override: null, ck: null, editCk: false, timer: null, flash: '', sel: {}, pending: [], manual: '', info: null, testVals: {} };

    const store = {
      get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
      del(k) { try { localStorage.removeItem(k); } catch (e) { /* rien */ } }
    };
    const today = () => E.ymd(new Date());
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
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
    const joinEt = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' et ' + a[a.length - 1];
    const lab = T => (plan.sessions[T] && plan.sessions[T].label) || T;

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

    /* ---------- Vues ---------- */

    function render() {
      if (!plan) return;
      const t = today();
      let h = ui.flash ? '<p class="flash" role="status">' + esc(ui.flash) + '</p>' : '';
      if (ui.tab === 'today') h += viewToday(t);
      else if (ui.tab === 'week') h += viewWeek(t);
      else h += viewSettings(t);
      if (ui.info) h += sheet(ui.info.ex, ui.info.key);
      root.innerHTML = h;
      document.body.classList.toggle('sheet-open', !!ui.info);
      document.querySelectorAll('.tabs button').forEach(b => {
        if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
      updateTimerLabel();
    }

    function viewSetup(t) {
      return '<header class="top"><h1>Socle</h1><p class="lede">La séance du jour, ta régularité et les décisions de charge. Tout reste sur ce téléphone.</p></header>' +
        '<section class="block"><h2>Pour commencer</h2>' +
        '<label class="field"><span>Première zone de douleur à suivre</span><input id="f-z1" type="text" placeholder="Par exemple : bas du dos" autocomplete="off"></label>' +
        '<label class="field"><span>Deuxième zone</span><input id="f-z2" type="text" placeholder="Par exemple : épaule" autocomplete="off"></label>' +
        '<label class="field"><span>Début du plan</span><input id="f-start" type="date" value="' + (E.weekday(t) === 0 ? E.addDays(t, 1) : E.mondayOf(t)) + '"></label>' +
        '<p class="hint">Ajoute l\'app à l\'écran d\'accueil (Partager, puis Sur l\'écran d\'accueil) : c\'est ce qui protège tes données de l\'effacement automatique de Safari.</p>' +
        '<button class="primary" data-a="setup">Commencer</button></section>';
    }

    function viewToday(t) {
      if (!state.settings.setup) return viewSetup(t);
      const st = E.streakInfo(state, plan, t);
      let h = '<header class="top"><h1>' + esc(longDate(t)) + '</h1><p class="meta">Semaine ' + E.weekNumber(state, t) +
        ' du plan. Série de ' + plural(st.streak, 'semaine') + ', ' + E.points(state, plan, t) + ' points.</p></header>';
      h += viewPhase(t) + viewCheckin(t) + viewTests(t) + viewDecisions(t) + viewTravel(t) + viewSession(t);
      return h;
    }

    function scale(action, field, val, from, to) {
      let h = '<div class="scale" role="group" style="grid-template-columns:repeat(' + (to - from + 1) + ',1fr)">';
      for (let i = from; i <= to; i++) {
        h += '<button class="tick" data-a="' + action + '" data-f="' + field + '" data-v="' + i + '" aria-pressed="' + (val === i) + '">' + i + '</button>';
      }
      return h + '</div>';
    }

    function viewCheckin(t) {
      const c = state.checkins[t];
      if (c && !ui.editCk) {
        return '<section class="block"><p class="quiet-text">Point du matin : ' + esc(zl('z1')) + ' ' + c.z1 + ', ' + esc(zl('z2')) + ' ' + c.z2 +
          ', courbatures ' + DOMS[c.doms] + '. <button class="link" data-a="edit-ck">Modifier</button></p></section>';
      }
      if (!ui.ck) ui.ck = c ? { z1: c.z1, z2: c.z2, doms: c.doms } : { z1: null, z2: null, doms: null };
      const k = ui.ck;
      const ready = k.z1 !== null && k.z2 !== null && !!k.doms;
      let h = '<section class="block"><h2>Point du matin</h2>';
      h += '<p class="label">' + esc(zl('z1')) + ', douleur sur 10</p>' + scale('ck', 'z1', k.z1, 0, 10);
      h += '<p class="label">' + esc(zl('z2')) + ', douleur sur 10</p>' + scale('ck', 'z2', k.z2, 0, 10);
      h += '<p class="label">Courbatures</p><div class="seg">' + ['none', 'moderate', 'strong'].map(v =>
        '<button data-a="ck" data-f="doms" data-v="' + v + '" aria-pressed="' + (k.doms === v) + '">' + cap(DOMS[v]) + '</button>').join('') + '</div>';
      h += '<button class="primary" data-a="save-ck"' + (ready ? '' : ' disabled') + '>Enregistrer le point du matin</button></section>';
      return h;
    }

    function exName(key) {
      for (const T of Object.keys(plan.sessions)) {
        for (const slot of plan.sessions[T].slots) {
          for (const o of slot.options) if (o.key === key) return plan.exercises[o.ex] ? plan.exercises[o.ex].name : o.ex;
        }
      }
      return key;
    }
    function optionOf(key) {
      for (const T of Object.keys(plan.sessions)) for (const slot of plan.sessions[T].slots) for (const o of slot.options) if (o.key === key) return o;
      return null;
    }

    function viewDecisions(t) {
      ui.pending = E.pendingDecisions(state, plan, t);
      return ui.pending.map((p, i) => {
        if (p.kind === 'up' && !ui.sel[p.id]) ui.sel[p.id] = [p.candidates[0].key];
        return card(p, i);
      }).join('');
    }

    function card(p, i) {
      const btns = (ok, no) => '<div class="actions"><button class="primary" data-a="decide" data-i="' + i + '" data-ok="1"' +
        (p.kind === 'up' && !(ui.sel[p.id] || []).length ? ' disabled' : '') + '>' + ok + '</button>' +
        (no ? '<button class="secondary" data-a="decide" data-i="' + i + '" data-ok="0">' + no + '</button>' : '') + '</div>';
      if (p.kind === 'up') {
        const n = plan.sessions[p.type].stable;
        const sel = ui.sel[p.id] || [];
        return '<section class="decision"><h2>Monter d\'un cran en ' + sname(p.type) + ' ?</h2>' +
          '<p>Tes ' + n + ' dernières séances ' + p.type + ' sont bien tolérées. Une seule variable change, sur un exercice ou deux au maximum.</p>' +
          '<div class="choices">' + p.candidates.map(c => '<button class="choice" data-a="pick" data-i="' + i + '" data-k="' + esc(c.key) + '" aria-pressed="' + sel.includes(c.key) + '">' +
            '<span class="choice-name">' + esc(exName(c.key)) + '</span><span class="choice-dose">' + esc(c.from) + ', puis ' + esc(c.to) + '</span></button>').join('') + '</div>' +
          btns('Monter d\'un cran', 'Pas maintenant') + '</section>';
      }
      if (p.kind === 'down') {
        let what;
        if (p.target.keys.length) {
          what = (p.target.revert ? 'Retour sur la dernière montée : ' : 'Retour au palier précédent : ') + p.target.keys.map(k => {
            const o = optionOf(k); const cur = Math.min(state.paliers[k] || 0, o.ladder.length - 1);
            return esc(exName(k)) + ' (' + esc(o.ladder[cur - 1]) + ')';
          }).join(', ') + '.';
        } else {
          what = 'Tu es déjà au palier de départ : fais les séances ' + p.type + ' à moitié pendant une semaine.';
        }
        return '<section class="decision warn"><h2>Redescendre en ' + sname(p.type) + ' ?</h2>' +
          p.reasons.map(r => '<p>' + esc(r) + '</p>').join('') + '<p>' + what + ' Aucune montée proposée sur cette séance pendant une semaine.</p>' +
          btns('Redescendre', 'Garder la dose') + '</section>';
      }
      if (p.kind === 'intro') {
        return '<section class="decision"><h2>Nouvel exercice : ' + esc(p.intro.name.toLowerCase()) + '</h2><p>' + esc(p.intro.text) + '</p>' +
          btns('Ajouter l\'exercice', 'Pas maintenant') + '</section>';
      }
      return '<section class="decision' + (p.title ? '' : ' warn') + '">' + (p.title ? '<h2>' + esc(p.title) + '</h2>' : '') + '<p>' + esc(p.text) + '</p>' + btns('Compris', null) + '</section>';
    }

    function viewPhase(t) {
      const ph = E.phaseOf(plan, t);
      if (!ph) return '';
      let h = '<section class="decision phase"><h2>' + esc(ph.title) + '</h2><p>' + esc(ph.text) + '</p>';
      if (ph.checklist && plan.skiChecklist) h += '<p class="label">Liste de contrôle ski</p><ul class="plain">' + plan.skiChecklist.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
      return h + '</section>';
    }

    function viewTests(t) {
      if (!E.testDue(state, plan, t)) return '';
      let h = '<section class="decision"><h2>Tests de la quinzaine</h2><p>' + esc(plan.tests.intro) + '</p>';
      plan.tests.items.forEach(it => {
        h += '<label class="field"><span>' + esc(it.label) + ', en ' + esc(it.unit) + '</span><input id="t-' + it.key + '" type="number" inputmode="numeric" min="0" max="' + it.max + '" value="' + esc(ui.testVals[it.key] || '') + '"></label>';
      });
      return h + '<div class="actions"><button class="primary" data-a="save-tests">Enregistrer les tests</button><button class="secondary" data-a="skip-tests">Plus tard</button></div></section>';
    }

    function viewTravel(t) {
      const on = !!state.travel[E.mondayOf(t)];
      return '<section class="block"><div class="row"><span id="lbl-travel">Semaine de voyage</span>' +
        '<button class="switch" role="switch" aria-labelledby="lbl-travel" data-a="travel" aria-checked="' + on + '"></button></div>' +
        (on ? '<p class="hint">Objectif de la semaine plancher : A, B, A et une séance C, toutes faisables en chambre d\'hôtel.</p>' : '') + '</section>';
    }

    function viewSession(t) {
      const doneToday = state.sessions.filter(s => s.date === t);
      const sug = E.suggestion(state, plan, t);
      let type = ui.override;
      if (!type && draft && draft.date === t && draft.type) type = draft.type;
      if (!type && !doneToday.length) type = sug;
      let h = '<section class="block"><div class="picker" role="group" aria-label="Choisir la séance">' +
        E.visibleTypes(plan, t).concat(type && !E.visibleTypes(plan, t).includes(type) ? [type] : []).map(T => '<button data-a="pick-type" data-t="' + T + '" aria-pressed="' + (type === T) + '"' + (lab(T).length > 1 ? ' class="wide-pick"' : '') + '>' + esc(lab(T)) + '</button>').join('') + '</div>';
      const rem = E.weekRemaining(state, plan, t);
      h += '<p class="meta">' + (E.skiWeek(plan, E.mondayOf(t)) ? 'Semaine de ski : la routine du matin suffit.' : (rem.length ? 'Reste cette semaine : ' + joinEt(rem.map(lab)) + '. Tu choisis le jour.' : 'Objectif de la semaine atteint.')) + '</p>';
      if (doneToday.length) {
        h += doneToday.map(s => '<p class="done-line">' + cap(sname(s.type)) + ' faite aujourd\'hui. Effort ' + s.effort + ', douleur ' + PAIN[s.painDuring] +
          '. <button class="link" data-a="undo" data-id="' + esc(s.id) + '">Annuler</button></p>').join('');
      }
      if (!type) {
        if (!doneToday.length) {
          const travel = !!state.travel[E.mondayOf(t)];
          h += '<h2>Repos</h2><p class="quiet-text">' + (travel ? 'Semaine plancher atteinte. Une séance de plus reste possible.' : 'Rien de structuré aujourd\'hui. Choisis une séance si tu veux quand même en faire une.') + '</p>';
        } else {
          h += '<p class="quiet-text">Une autre séance reste possible avec les boutons plus haut.</p>';
        }
        return h + '</section>';
      }
      const def = plan.sessions[type];
      if (!draft || draft.date !== t || draft.type !== type) {
        draft = { date: t, type, done: [], hard: [], effort: null, pain: null, tech: true };
        saveDraft();
      }
      const items = E.sessionPlan(state, plan, type);
      h += '<h2>' + esc(cap(sname(type))) + ', ' + esc(def.name.toLowerCase()) + '</h2><p class="meta">' + def.minutes + ' minutes réelles.' +
        (sug && sug !== type ? ' Suggestion du jour : ' + sname(sug) + '.' : '') + '</p>';
      const phN = E.phaseOf(plan, t);
      if (phN && phN.note && type !== 'S') h += '<p class="note">' + esc(phN.note) + '</p>';
      if (def.kind === 'long' && E.longTooSoon(state, plan, t)) h += '<p class="note">Ta dernière séance longue date de moins de 48 heures. Si tu peux, attends demain.</p>';
      if (E.holdActive(state, type, t)) h += '<p class="note">Dose réduite jusqu\'au ' + E.shortDate(state.holds[type]) + ' : aucune montée proposée sur cette séance d\'ici là.</p>';
      h += items.length ? '<ol class="exlist">' + items.map(exItem).join('') + '</ol>' : '<p class="quiet-text">Séance menée par ton instructeur ou ton kiné. Note l\'effort et la douleur à la fin.</p>';
      const wk = E.weekNumber(state, t);
      h += '<div class="finish"><p class="label">Effort ressenti, sur 10. ' + (wk <= 2 ? 'Vise 4 à 5.' : 'Garde de la marge.') + '</p>' + scale('dr', 'effort', draft.effort, 1, 10);
      h += '<p class="label">Douleur pendant la séance</p><div class="seg">' + ['stable', 'small', 'over'].map(v =>
        '<button data-a="dr" data-f="pain" data-v="' + v + '" aria-pressed="' + (draft.pain === v) + '">' + cap(PAIN[v]) + '</button>').join('') + '</div>';
      h += '<p class="label">Technique propre</p><div class="seg">' +
        '<button data-a="dr" data-f="tech" data-v="1" aria-pressed="' + (draft.tech === true) + '">Oui</button>' +
        '<button data-a="dr" data-f="tech" data-v="0" aria-pressed="' + (draft.tech === false) + '">Non</button></div>';
      h += '<button class="primary" data-a="finish"' + (draft.effort !== null && draft.pain ? '' : ' disabled') + '>Terminer la séance</button></div></section>';
      return h;
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
      h += '<div class="ex-body"><button class="ex-name" data-a="info" data-ex="' + esc(it.ex) + '" data-k="' + esc(it.key) + '"><span>' + esc(it.name) + '</span><span class="chev" aria-hidden="true">›</span></button>' +
        (it.alternates ? '<p class="tag">En alternance d\'une séance à l\'autre</p>' : '');
      h += '<p class="dose">' + esc(it.dose) + '</p><div class="ex-tools">';
      if (it.hold) h += '<button class="tool' + (running ? ' running' : '') + '" id="tm-' + esc(it.key) + '" data-a="timer" data-k="' + esc(it.key) + '" data-s="' + it.hold + '">Minuteur ' + secs(it.hold) + '</button>';
      h += '<button class="tool" data-a="hard" data-k="' + esc(it.key) + '" aria-pressed="' + hard + '">Trop dur</button>';
      h += '</div></div><span class="ladder" role="img" aria-label="Palier ' + (it.palier + 1) + ' sur ' + (it.max + 1) + '">' + rungs(it.palier, it.max) + '</span></li>';
      return h;
    }

    function sheet(exId, key) {
      const ex = plan.exercises[exId];
      if (!ex) return '';
      const d = ex.detail || {};
      const o = key ? optionOf(key) : null;
      const dose = o ? o.ladder[Math.min(state.paliers[o.key] || 0, o.ladder.length - 1)] : '';
      const sec = (title, body) => body ? '<h3>' + title + '</h3>' + body : '';
      const para = x => x ? '<p>' + esc(x) + '</p>' : '';
      const list = (tag, a) => a && a.length ? '<' + tag + '>' + a.map(x => '<li>' + esc(x) + '</li>').join('') + '</' + tag + '>' : '';
      let h = '<div class="sheet-backdrop" data-a="close-info"></div><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">';
      h += '<div class="sheet-head"><h2 id="sheet-title" tabindex="-1">' + esc(ex.name) + '</h2><button class="secondary" data-a="close-info">Fermer</button></div>';
      if (dose) h += '<p class="dose">' + esc(dose) + '</p>';
      h += para(d.why);
      h += sec('L\'essentiel', para(ex.cue));
      h += sec('Position de départ', para(d.setup));
      h += sec('Mouvement', list('ol', d.steps));
      h += sec('Respiration', para(d.breath));
      h += sec('Ce que tu dois sentir', para(d.feel));
      h += sec('À éviter', list('ul', d.avoid));
      h += sec('Plus facile', para(d.easier));
      if (d.video) {
        h += '<h3>Vidéos</h3><p><a class="link" href="https://www.youtube.com/results?search_query=' + encodeURIComponent(d.video) + '" target="_blank" rel="noopener">Chercher « ' + esc(d.video) + ' » sur YouTube</a></p>' +
          (plan.videoNote ? '<p class="hint">' + esc(plan.videoNote) + '</p>' : '');
      }
      return h + '</section>';
    }

    function viewWeek(t) {
      if (!state.settings.setup) return viewSetup(t);
      const st = E.streakInfo(state, plan, t);
      const m = E.mondayOf(t);
      const c = st.current;
      let h = '<header class="top"><h1>Ta régularité</h1><p class="meta">' + E.points(state, plan, t) + ' points au total.</p></header>';
      h += '<section class="block"><p>Série de ' + plural(st.streak, 'semaine') + ' au niveau plancher, record ' + st.best + '. ' +
        (st.jokers ? plural(st.jokers, 'joker') + ' en réserve.' : 'Pas de joker en réserve.') + '</p>' +
        '<p class="hint">Une semaine compte dès 3 séances courtes et 1 longue. Chaque bloc de 4 semaines réussies donne un joker, 2 au maximum, qui protège la série une semaine ratée.</p></section>';
      h += '<section class="block"><h2>Cette semaine</h2><div class="strip">';
      for (let i = 0; i < 7; i++) {
        const d = E.addDays(m, i);
        const did = state.sessions.filter(s => s.date === d).map(s => (lab(s.type).length > 1 ? lab(s.type).charAt(0) : s.type)).join('');
        h += '<div class="day' + (did ? ' done' : '') + (d === t ? ' today' : '') + '"><span>' + cap(JOURS[E.weekday(d)].slice(0, 3)) + '</span><b>' + esc(did) + '</b></div>';
      }
      const remW = E.weekRemaining(state, plan, t);
      h += '</div><p>' + (E.skiWeek(plan, m) ? 'Semaine de ski : elle compte automatiquement pour ta série. ' : (remW.length ? 'Reste : ' + joinEt(remW.map(lab)) + '. ' : 'Semaine complète. ')) + c.short + ' séance' + (c.short > 1 ? 's' : '') + ' courte' + (c.short > 1 ? 's' : '') + ' sur 3 et ' + c.long + ' longue' + (c.long > 1 ? 's' : '') + ' sur 1 pour le niveau plancher. Semaine complète : 4 courtes et 2 longues.</p></section>';
      h += '<section class="block"><h2>Quatre dernières semaines</h2><table class="tbl"><thead><tr><th>Semaine du</th><th>Séances</th><th>' + esc(zl('z1')) + '</th><th>' + esc(zl('z2')) + '</th></tr></thead><tbody>';
      for (let w = 0; w < 4; w++) {
        const mw = E.addDays(m, -7 * w);
        if (mw < E.mondayOf(state.settings.start)) break;
        const cw = E.weekCounts(state, plan, mw);
        const f = v => v === null ? 'aucun relevé' : String(v).replace('.', ',');
        h += '<tr><td>' + E.shortDate(mw) + '</td><td>' + (cw.short + cw.long) + '</td><td>' + f(E.avgPain(state, mw, 'z1')) + '</td><td>' + f(E.avgPain(state, mw, 'z2')) + '</td></tr>';
      }
      h += '</tbody></table><p class="hint">Douleur moyenne des points du matin.</p></section>';
      const td = Object.keys(state.tests).sort().reverse().slice(0, 4);
      if (td.length) {
        h += '<section class="block"><h2>Tests de la quinzaine</h2><table class="tbl"><thead><tr><th>Date</th><th>Équilibre G, D</th><th>Planche G, D</th><th>Rowing</th></tr></thead><tbody>' +
          td.map(d => { const x = state.tests[d]; const v = k => x[k] == null ? '' : x[k]; return '<tr><td>' + E.shortDate(d) + '</td><td>' + v('balL') + ', ' + v('balR') + '</td><td>' + v('spL') + ', ' + v('spR') + '</td><td>' + v('row') + '</td></tr>'; }).join('') +
          '</tbody></table><p class="hint">Secondes pour les tenues, répétitions pour le rowing.</p></section>';
      }
      const recent = state.sessions.slice().sort((a, b) => b.ts - a.ts).slice(0, 8);
      h += '<section class="block"><h2>Dernières séances</h2>' + (recent.length ? '<ul class="plain">' + recent.map(s =>
        '<li><span class="when">' + E.shortDate(s.date) + ', ' + esc(lab(s.type)) + '</span> effort ' + s.effort + ', douleur ' + PAIN[s.painDuring] + ', ' + STATUS[E.statusFor(state, s, t)] + '.</li>').join('') + '</ul>'
        : '<p class="quiet-text">Aucune séance pour l\'instant. La première se lance depuis Aujourd\'hui.</p>') + '</section>';
      h += '<section class="block"><h2>Paliers actuels</h2>';
      Object.keys(plan.sessions).forEach(T => {
        const opts = E.activeOptions(state, plan, T);
        if (!opts.length) return;
        h += '<p class="label">' + esc(cap(sname(T))) + '</p><ul class="plain">' + opts.map(o => {
          const p = Math.min(state.paliers[o.key] || 0, o.ladder.length - 1);
          return '<li><button class="inline-ex" data-a="info" data-ex="' + esc(o.ex) + '" data-k="' + esc(o.key) + '">' + esc(plan.exercises[o.ex].name) + '</button> : ' + esc(o.ladder[p]) + ' <span class="hint-inline">(' + (p + 1) + ' sur ' + o.ladder.length + ')</span></li>';
        }).join('') + '</ul>';
      });
      h += '</section><section class="block"><h2>Badges</h2><ul class="badges">' + E.badges(state, plan, t).map(b =>
        '<li class="' + (b.got ? 'got' : '') + '">' + esc(b.name) + (b.got ? '' : '<span class="sr"> (pas encore)</span>') + '</li>').join('') + '</ul></section>';
      h += '<section class="block"><h2>Résumé pour Claude</h2><p class="quiet-text">Copie les 28 derniers jours et colle les dans une conversation pour faire le point.</p>' +
        '<button class="primary" data-a="copy-claude">Copier le résumé</button>' + manualBox() + '</section>';
      return h;
    }

    function manualBox() {
      return ui.manual ? '<label class="field"><span>Texte à copier à la main</span><textarea readonly id="f-manual">' + esc(ui.manual) + '</textarea></label>' : '';
    }

    function viewSettings(t) {
      const s = state.settings;
      let h = '<header class="top"><h1>Réglages</h1><p class="meta">Plan version ' + plan.version + '.</p></header>';
      if (s.setup) {
        h += '<section class="block"><h2>Suivi</h2>' +
          '<label class="field"><span>Première zone de douleur</span><input id="f-z1" type="text" value="' + esc(s.z1) + '" autocomplete="off"></label>' +
          '<label class="field"><span>Deuxième zone</span><input id="f-z2" type="text" value="' + esc(s.z2) + '" autocomplete="off"></label>' +
          '<label class="field"><span>Début du plan</span><input id="f-start" type="date" value="' + esc(s.start) + '"></label>' +
          '<button class="primary" data-a="save-settings">Enregistrer les réglages</button></section>';
      }
      h += '<section class="block"><h2>Sauvegarde</h2><p class="quiet-text">Tes données ne quittent jamais ce téléphone. Copie une sauvegarde de temps en temps et range la dans tes notes.</p>' +
        '<button class="secondary wide" data-a="copy-backup">Copier la sauvegarde</button>' + manualBox() +
        '<label class="field"><span>Restaurer une sauvegarde</span><textarea id="f-import" placeholder="Colle ici une sauvegarde ou un résumé copié depuis l\'app"></textarea></label>' +
        '<button class="secondary wide" data-a="import">Restaurer</button></section>';
      h += '<section class="block"><h2>Règles</h2><ul class="plain">' + plan.rules.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></section>';
      h += '<section class="block"><h2>Comment l\'app décide</h2><ul class="plain">' + plan.logic.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></section>';
      h += '<section class="block"><h2>Tout effacer</h2><p class="quiet-text">Supprime toutes les séances, les points du matin et les paliers de ce téléphone.</p>' +
        '<button class="secondary wide danger" data-a="reset">Tout effacer</button></section>';
      return h;
    }

    /* ---------- Actions ---------- */

    function copyText(text, okMsg) {
      ui.manual = '';
      const fallback = () => { ui.manual = text; ui.flash = 'Copie automatique impossible : le texte apparaît plus bas, à sélectionner à la main.'; render(); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => { ui.flash = okMsg; render(); }, fallback);
      } else fallback();
    }

    let actx = null;
    function audio() {
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
      } catch (e) { actx = null; }
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

    const actions = {
      setup() {
        const z1 = document.getElementById('f-z1').value.trim();
        const z2 = document.getElementById('f-z2').value.trim();
        const st = document.getElementById('f-start').value;
        state.settings.z1 = z1; state.settings.z2 = z2;
        state.settings.start = /^\d{4}-\d{2}-\d{2}$/.test(st) ? st : today();
        state.settings.setup = true;
        save();
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      },
      'save-settings'() {
        actions.setup();
        ui.flash = 'Réglages enregistrés.';
      },
      'edit-ck'() { ui.editCk = true; ui.ck = null; },
      info(d) { ui.info = { ex: d.ex, key: d.k || null }; return 'sheet'; },
      'close-info'() { ui.info = null; },
      'save-tests'() {
        const vals = {};
        let n = 0;
        plan.tests.items.forEach(it => {
          const el = document.getElementById('t-' + it.key);
          const v = el ? el.value.trim() : '';
          if (v !== '' && !isNaN(Number(v))) { vals[it.key] = Math.max(0, Math.min(it.max, Number(v))); n++; }
        });
        if (!n) { ui.flash = 'Renseigne au moins un test avant d\'enregistrer.'; return; }
        state.tests[today()] = vals;
        ui.testVals = {};
        save();
        ui.flash = 'Tests enregistrés. +5 points.';
      },
      'skip-tests'() { state.testSkip = today(); save(); ui.flash = 'Les tests te seront proposés demain.'; },
      ck(d) {
        if (!ui.ck) ui.ck = { z1: null, z2: null, doms: null };
        ui.ck[d.f] = d.f === 'doms' ? d.v : Number(d.v);
      },
      'save-ck'() {
        const k = ui.ck;
        if (!k || k.z1 === null || k.z2 === null || !k.doms) return;
        const t = today();
        const first = !state.checkins[t];
        state.checkins[t] = { z1: k.z1, z2: k.z2, doms: k.doms, ts: Date.now() };
        save();
        ui.ck = null; ui.editCk = false;
        ui.flash = first ? 'Point du matin enregistré. +2 points.' : 'Point du matin modifié.';
      },
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
        E.applyDecision(state, plan, p, ok, ui.sel[p.id], Date.now(), today());
        save();
        const msg = {
          up: ok ? 'Palier monté. +5 points.' : 'Noté. La proposition reviendra après ta prochaine ' + sname(p.type) + '.',
          down: ok ? 'Dose réduite pour une semaine. C\'était la règle : +15 points.' : 'Noté. La dose reste la même.',
          intro: ok ? 'Exercice ajouté. +5 points.' : 'Noté. La proposition reviendra après ta prochaine séance concernée.',
          info: ''
        };
        ui.flash = msg[p.kind] || '';
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
      },
      done(d) {
        const i = draft.done.indexOf(d.k);
        if (i >= 0) draft.done.splice(i, 1); else draft.done.push(d.k);
        saveDraft();
      },
      hard(d) {
        const i = draft.hard.indexOf(d.k);
        if (i >= 0) draft.hard.splice(i, 1); else draft.hard.push(d.k);
        saveDraft();
      },
      dr(d) {
        if (d.f === 'effort') draft.effort = Number(d.v);
        else if (d.f === 'pain') draft.pain = d.v;
        else if (d.f === 'tech') draft.tech = d.v === '1';
        saveDraft();
      },
      timer(d) {
        if (ui.timer && ui.timer.key === d.k) { stopTimer(); return; }
        audio();
        stopTimer();
        const s = Number(d.s);
        ui.timer = { key: d.k, secs: s, end: Date.now() + s * 1000 };
        tickId = setInterval(updateTimerLabel, 250);
      },
      finish() {
        if (!draft || draft.effort === null || !draft.pain) return;
        const t = today();
        const before = E.points(state, plan, t);
        const items = E.sessionPlan(state, plan, draft.type);
        const s = {
          id: 's' + Date.now().toString(36), date: t, ts: Date.now(), type: draft.type,
          items: items.map(it => ({ key: it.key, palier: it.palier })),
          done: draft.done.slice(), tooHard: draft.hard.slice(),
          effort: draft.effort, painDuring: draft.pain, technique: draft.tech !== false
        };
        state.sessions.push(s);
        save();
        const gain = E.points(state, plan, t) - before;
        draft = null; saveDraft(); ui.override = null; stopTimer();
        ui.flash = cap(sname(s.type)) + ' enregistrée. +' + gain + ' points.' +
          (s.painDuring === 'over' ? ' La douleur a trop monté : une proposition de redescente t\'attend en haut de la page.' : ' Demain matin, le point du matin dira si elle est bien tolérée.');
        window.scrollTo(0, 0);
      },
      undo(d) {
        const s = state.sessions.find(x => x.id === d.id);
        if (!s || !window.confirm('Annuler la ' + sname(s.type) + ' d\'aujourd\'hui ?')) return;
        state.sessions = state.sessions.filter(x => x.id !== d.id);
        save();
        ui.flash = 'Séance annulée.';
      },
      'copy-claude'() { copyText(E.exportText(state, plan, today()), 'Résumé copié. Colle le dans une conversation avec Claude.'); return 'async'; },
      'copy-backup'() { copyText(JSON.stringify(state), 'Sauvegarde copiée.'); return 'async'; },
      import() {
        const txt = (document.getElementById('f-import').value || '').trim();
        const j = txt.charAt(0) === '{' ? txt : txt.slice(txt.indexOf('\n{') + 1);
        let s = null;
        try { s = JSON.parse(j); } catch (e) { s = null; }
        if (!s || !s.settings || !Array.isArray(s.sessions)) { ui.flash = 'Restauration impossible : le texte collé ne contient pas de sauvegarde Socle.'; return; }
        if (!window.confirm('Remplacer toutes les données de ce téléphone par cette sauvegarde ?')) return;
        state = E.normalize(s, today());
        draft = null; saveDraft();
        save();
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
      const r = fn(b.dataset);
      if (r !== 'async') render();
      if (r === 'sheet') {
        const sh = document.querySelector('.sheet');
        if (sh) sh.scrollTop = 0;
        const ti = document.getElementById('sheet-title');
        if (ti) ti.focus();
      }
    });

    root.addEventListener('input', e => {
      const id = e.target && e.target.id;
      if (id && id.indexOf('t-') === 0) ui.testVals[id.slice(2)] = e.target.value;
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ui.info) { ui.info = null; render(); }
    });

    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      ui.tab = b.dataset.tab; ui.flash = ''; ui.manual = '';
      render(); window.scrollTo(0, 0);
    }));

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });

    load();
    fetch('plan.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(p => { plan = p; render(); })
      .catch(() => {
        root.innerHTML = '<section class="block"><h1>Plan introuvable</h1><p>Le fichier du plan n\'a pas pu être chargé. Ouvre l\'app une première fois avec une connexion internet ; ensuite, elle fonctionne hors ligne.</p></section>';
      });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
}
