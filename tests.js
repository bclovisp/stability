// Lancer avec : node tests.js
'use strict';
const assert = require('assert');
const E = require('./app.js');
const plan = require('./plan.json');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

let clock = 1000;
const START = '2026-09-28'; // lundi
function fresh() {
  const s = E.emptyState(START);
  s.settings.setup = true; s.settings.z1 = 'Zone 1'; s.settings.z2 = 'Zone 2';
  return s;
}
function ck(s, date, z1, z2, doms) { s.checkins[date] = { z1, z2, doms: doms || 'none', ts: clock++ }; }
function sess(s, date, type, extra) {
  const x = Object.assign({ id: 's' + clock, date, ts: clock++, type, items: [], done: [], tooHard: [], effort: 5, painDuring: 'stable', technique: true }, extra || {});
  s.sessions.push(x);
  return x;
}
const D = n => E.addDays(START, n);

test('dates : lundi, décalages, écart', () => {
  assert.strictEqual(E.mondayOf('2026-10-01'), '2026-09-28');
  assert.strictEqual(E.mondayOf('2026-10-04'), '2026-09-28');
  assert.strictEqual(E.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(E.diffDays('2026-10-24', '2026-10-27'), 3); // passage à l'heure d'hiver en Europe
});

test('niveau habituel = médiane des 7 jours précédents', () => {
  const s = fresh();
  [3, 4, 5, 4, 3, 4, 9].forEach((v, i) => ck(s, D(i), v, 1));
  assert.strictEqual(E.baseline(s, D(7), 'z1'), 4);
});

test('séance bien tolérée, puis non tolérée à +2 le lendemain', () => {
  const s = fresh();
  for (let i = 0; i < 7; i++) ck(s, D(i), 4, 2);
  const a = sess(s, D(6), 'A');
  assert.strictEqual(E.sessionStatus(s, a), 'pending');
  ck(s, D(7), 5, 2);
  assert.strictEqual(E.sessionStatus(s, a), 'ok');
  ck(s, D(7), 6, 2);
  assert.strictEqual(E.sessionStatus(s, a), 'ko');
});

test('effort 7, douleur de plus de 2 ou technique non : non tolérée', () => {
  const s = fresh();
  ck(s, D(1), 3, 3);
  assert.strictEqual(E.sessionStatus(s, sess(s, D(0), 'A', { effort: 7 })), 'ko');
  assert.strictEqual(E.sessionStatus(s, sess(s, D(0), 'A', { painDuring: 'over' })), 'ko');
  assert.strictEqual(E.sessionStatus(s, sess(s, D(0), 'A', { technique: false })), 'ko');
});

test('courbatures 3 matins de suite : non tolérée', () => {
  const s = fresh();
  ck(s, D(0), 3, 3);
  const c = sess(s, D(0), 'C');
  ck(s, D(1), 3, 3, 'moderate'); ck(s, D(2), 3, 3, 'moderate');
  assert.strictEqual(E.sessionStatus(s, c), 'ok');
  ck(s, D(3), 3, 3, 'moderate');
  assert.strictEqual(E.sessionStatus(s, c), 'ko');
});

test('séance sans point du matin le lendemain : non évaluée', () => {
  const s = fresh();
  const a = sess(s, D(0), 'A');
  assert.strictEqual(E.statusFor(s, a, D(1)), 'pending');
  assert.strictEqual(E.statusFor(s, a, D(2)), 'unknown');
});

function tolerated(s, type, days) {
  days.forEach(d => { ck(s, D(d), 3, 3); sess(s, D(d), type); ck(s, D(d + 1), 3, 3); });
}

test('montée proposée après 3 séances A bien tolérées, pas après 2', () => {
  const s = fresh();
  tolerated(s, 'A', [0, 3]);
  assert.strictEqual(E.upProposal(s, plan, 'A', D(4)), null);
  tolerated(s, 'A', [7]);
  const p = E.upProposal(s, plan, 'A', D(8));
  assert.ok(p, 'proposition attendue');
  assert.ok(p.candidates.length >= 1 && p.candidates.length <= 2);
  assert.ok(!p.candidates.some(c => c.key === 'A1'), 'la respiration n\'a qu\'un palier');
});

test('C monte après 2 séances, et une montée remet le compteur à zéro', () => {
  const s = fresh();
  tolerated(s, 'C', [2, 9]);
  const p = E.upProposal(s, plan, 'C', D(10));
  assert.ok(p);
  E.applyDecision(s, plan, p, true, [p.candidates[0].key], clock++, D(10));
  assert.strictEqual(s.paliers[p.candidates[0].key], 1);
  assert.strictEqual(E.upProposal(s, plan, 'C', D(10)), null);
  tolerated(s, 'C', [16]);
  assert.strictEqual(E.upProposal(s, plan, 'C', D(17)), null);
  tolerated(s, 'C', [23]);
  assert.ok(E.upProposal(s, plan, 'C', D(24)));
});

test('« trop dur » exclut l\'exercice des candidats', () => {
  const s = fresh();
  tolerated(s, 'C', [2]);
  ck(s, D(9), 3, 3); sess(s, D(9), 'C', { tooHard: ['C2'] }); ck(s, D(10), 3, 3);
  const p = E.upProposal(s, plan, 'C', D(10));
  assert.ok(p && !p.candidates.some(c => c.key === 'C2'));
});

test('refus : la proposition revient après la séance suivante', () => {
  const s = fresh();
  tolerated(s, 'D', [5, 12]);
  const p = E.upProposal(s, plan, 'D', D(13));
  E.applyDecision(s, plan, p, false, [], clock++, D(13));
  assert.strictEqual(E.upProposal(s, plan, 'D', D(13)), null);
  tolerated(s, 'D', [19]);
  assert.ok(E.upProposal(s, plan, 'D', D(20)));
});

test('poussée au réveil : retour sur la dernière montée et blocage une semaine', () => {
  const s = fresh();
  tolerated(s, 'C', [2, 9]);
  const up = E.upProposal(s, plan, 'C', D(10));
  const key = up.candidates[0].key;
  E.applyDecision(s, plan, up, true, [key], clock++, D(10));
  for (let i = 10; i < 16; i++) ck(s, D(i), 3, 3);
  sess(s, D(16), 'C');
  ck(s, D(17), 7, 3);
  const downs = E.flareProposals(s, plan, D(17));
  assert.strictEqual(downs.length, 1);
  assert.strictEqual(downs[0].type, 'C');
  assert.deepStrictEqual(downs[0].target.keys, [key]);
  E.applyDecision(s, plan, downs[0], true, null, clock++, D(17));
  assert.strictEqual(s.paliers[key], 0);
  assert.ok(E.holdActive(s, 'C', D(20)));
  assert.ok(!E.holdActive(s, 'C', D(24)));
  assert.strictEqual(E.flareProposals(s, plan, D(17)).length, 0, 'déjà décidée');
});

test('deuxième poussée pendant la réduction : information, pas de seconde baisse', () => {
  const s = fresh();
  tolerated(s, 'C', [2, 9]);
  const up = E.upProposal(s, plan, 'C', D(10));
  E.applyDecision(s, plan, up, true, [up.candidates[0].key], clock++, D(10));
  for (let i = 10; i < 16; i++) ck(s, D(i), 3, 3);
  sess(s, D(16), 'C');
  ck(s, D(17), 7, 3);
  E.applyDecision(s, plan, E.flareProposals(s, plan, D(17))[0], true, null, clock++, D(17));
  ck(s, D(18), 7, 3);
  const next = E.flareProposals(s, plan, D(18));
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].kind, 'info');
});

test('douleur de plus de 2 pendant la séance : proposition immédiate', () => {
  const s = fresh();
  ck(s, D(0), 3, 3);
  sess(s, D(0), 'B', { painDuring: 'over' });
  const p = E.flareProposals(s, plan, D(0));
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].type, 'B');
  assert.strictEqual(p[0].target.keys.length, 0, 'déjà au palier de départ');
});

test('poussée sans séance récente : simple information', () => {
  const s = fresh();
  for (let i = 0; i < 7; i++) ck(s, D(i), 2, 2);
  ck(s, D(7), 6, 2);
  const p = E.flareProposals(s, plan, D(7));
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, 'info');
});

test('nouvel exercice : chaise contre le mur en semaine 3 si C et D bien tolérées', () => {
  const s = fresh();
  tolerated(s, 'C', [2, 9]);
  tolerated(s, 'D', [5, 12]);
  assert.strictEqual(E.introProposal(s, plan, D(13)), null, 'avant la semaine 3');
  const p = E.introProposal(s, plan, D(14));
  assert.ok(p && p.intro.id === 'wallSit');
  E.applyDecision(s, plan, p, true, null, clock++, D(14));
  assert.ok(E.sessionPlan(s, plan, 'C').some(i => i.key === 'C2b'));
  const d = E.sessionPlan(s, plan, 'D');
  assert.ok(d.some(i => i.key === 'D4w') && !d.some(i => i.key === 'D4'), 'remplace l\'assis debout au banc');
  assert.strictEqual(E.introProposal(s, plan, D(14)), null, 'la suivante attend sa date');
});

test('les nouveaux exercices arrivent un par un', () => {
  const s = fresh();
  tolerated(s, 'D', [33]);
  s.intros.wallSit = clock + 10; // acceptée après la dernière séance D
  assert.strictEqual(E.introProposal(s, plan, '2026-11-02'), null, 'aucune séance bien tolérée depuis la chaise contre le mur');
  clock += 20;
  tolerated(s, 'D', [34]);
  const p = E.introProposal(s, plan, '2026-11-02');
  assert.ok(p && p.intro.id === 'floorPress', 'le développé au sol suit la chaise contre le mur');
});

test('alternance en séance B', () => {
  const s = fresh();
  const first = E.sessionPlan(s, plan, 'B').find(i => i.slot === 'B3').key;
  sess(s, D(1), 'B');
  const second = E.sessionPlan(s, plan, 'B').find(i => i.slot === 'B3').key;
  assert.notStrictEqual(first, second);
});

test('série hebdomadaire, joker gagné après 4 semaines puis consommé', () => {
  const s = fresh();
  for (let w = 0; w < 4; w++) ['A', 'B', 'A', 'C'].forEach((t, i) => sess(s, D(w * 7 + i), t));
  let st = E.streakInfo(s, plan, D(28));
  assert.strictEqual(st.streak, 4);
  assert.strictEqual(st.jokers, 1);
  st = E.streakInfo(s, plan, D(35)); // semaine 5 ratée, on est en semaine 6
  assert.strictEqual(st.streak, 4, 'le joker protège la série');
  assert.strictEqual(st.jokers, 0);
  st = E.streakInfo(s, plan, D(42)); // semaine 6 ratée aussi
  assert.strictEqual(st.streak, 0);
});

test('semaine en cours non terminée : ne casse pas la série', () => {
  const s = fresh();
  ['A', 'B', 'A', 'C'].forEach((t, i) => sess(s, D(i), t));
  assert.strictEqual(E.streakInfo(s, plan, D(8)).streak, 1);
});

test('points', () => {
  const s = fresh();
  ck(s, D(0), 3, 3);
  sess(s, D(0), 'A', { effort: 5 });
  sess(s, D(1), 'C', { effort: 8 });
  assert.strictEqual(E.points(s, plan, D(1)), 2 + 13 + 20);
});

test('semaine de voyage : A, B, A puis C', () => {
  const s = fresh();
  s.travel[START] = true;
  assert.strictEqual(E.suggestion(s, plan, D(0)), 'A');
  sess(s, D(0), 'A');
  assert.strictEqual(E.suggestion(s, plan, D(1)), 'B');
  sess(s, D(1), 'B');
  assert.strictEqual(E.suggestion(s, plan, D(2)), 'A');
  sess(s, D(2), 'A');
  assert.strictEqual(E.suggestion(s, plan, D(3)), 'C');
  sess(s, D(3), 'D');
  assert.strictEqual(E.suggestion(s, plan, D(4)), null);
});

test('semaine normale : suggestion du jour, puis repos quand tout est fait', () => {
  const s = fresh();
  const seq = [];
  for (let i = 0; i < 6; i++) { const t = E.suggestion(s, plan, D(i)); seq.push(t); sess(s, D(i), t); }
  assert.deepStrictEqual(seq, ['A', 'B', 'C', 'A', 'B', 'D']);
  assert.strictEqual(E.suggestion(s, plan, D(6)), null);
});

test('semaine flexible : l\'app propose ce qui reste', () => {
  const s = fresh();
  sess(s, D(0), 'C');
  sess(s, D(1), 'B');
  assert.deepStrictEqual(E.weekRemaining(s, plan, D(2)), ['A', 'A', 'B', 'D']);
  assert.strictEqual(E.suggestion(s, plan, D(2)), 'A');
});

test('règle des 48 heures entre deux séances longues', () => {
  const s = fresh();
  sess(s, D(1), 'D');
  assert.ok(E.longTooSoon(s, plan, D(2)));
  assert.strictEqual(E.suggestion(s, plan, D(2)), 'A', 'C décalée');
  assert.ok(!E.longTooSoon(s, plan, D(3)));
});

test('dimanche : la séance manquante est proposée', () => {
  const s = fresh();
  ['A', 'B', 'C', 'A', 'B'].forEach((t, i) => sess(s, D(i), t));
  assert.strictEqual(E.suggestion(s, plan, D(6)), 'D');
});

test('séance encadrée : remplace D et compte comme longue', () => {
  const s = fresh();
  sess(s, D(5), 'R');
  assert.ok(!E.weekRemaining(s, plan, D(6)).includes('D'));
  assert.strictEqual(E.weekCounts(s, plan, START).long, 1);
  assert.strictEqual(E.sessionPlan(s, plan, 'R').length, 0);
});

test('séance encadrée douloureuse : information, pas de baisse de palier', () => {
  const s = fresh();
  ck(s, D(0), 3, 3);
  sess(s, D(0), 'R', { painDuring: 'over' });
  const p = E.flareProposals(s, plan, D(0));
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, 'info');
});

test('tests de la quinzaine : après la première séance, puis tous les 14 jours', () => {
  const s = fresh();
  assert.ok(!E.testDue(s, plan, D(0)));
  sess(s, D(0), 'A');
  assert.ok(E.testDue(s, plan, D(0)));
  s.tests[D(0)] = { balL: 20 };
  assert.ok(!E.testDue(s, plan, D(10)));
  assert.ok(E.testDue(s, plan, D(14)));
  s.testSkip = D(14);
  assert.ok(!E.testDue(s, plan, D(14)));
  assert.ok(E.testDue(s, plan, D(15)));
});

test('fiches : chaque exercice a une position de départ et un mouvement', () => {
  Object.entries(plan.exercises).forEach(([k, ex]) => {
    assert.ok(ex.detail && ex.detail.setup && ex.detail.steps && ex.detail.steps.length, 'fiche incomplète ' + k);
    assert.ok(ex.detail.why, 'objectif manquant ' + k);
  });
  const txt = JSON.stringify(plan);
  assert.ok(!/ - |—|–/.test(txt), 'aucun tiret dans le plan');
});

test('soulevé sur une jambe : arrive en janvier et remplace la rotation externe couché', () => {
  const s = fresh();
  ['wallSit', 'floorPress', 'stepDown', 'lateralWalk', 'splitSquatIso', 'intervals', 'hinge'].forEach(k => { s.intros[k] = 1; });
  const c = E.sessionPlan(s, plan, 'C').map(i => i.key);
  assert.ok(c.includes('C5h') && !c.includes('C5'));
  assert.ok(E.sessionPlan(s, plan, 'B').some(i => i.key === 'B3r' || i.key === 'B3w'));
});

test('export : le JSON final se relit', () => {
  const s = fresh();
  ck(s, D(0), 3, 3); sess(s, D(0), 'A');
  const txt = E.exportText(s, plan, D(1));
  const j = JSON.parse(txt.slice(txt.indexOf('\n{') + 1));
  assert.strictEqual(j.sessions.length, 1);
  assert.ok(!/ - |—|–/.test(txt), 'aucun tiret dans le texte');
});

test('plan : toutes les clés sont uniques et les exercices existent', () => {
  const keys = new Set();
  Object.values(plan.sessions).forEach(def => def.slots.forEach(slot => slot.options.forEach(o => {
    assert.ok(!keys.has(o.key), 'clé en double ' + o.key);
    keys.add(o.key);
    assert.ok(plan.exercises[o.ex], 'exercice manquant ' + o.ex);
    if (o.holds) assert.strictEqual(o.holds.length, o.ladder.length, 'minuteurs ' + o.key);
  })));
  plan.intros.forEach(it => {
    const used = Object.values(plan.sessions).some(def => def.slots.some(sl => sl.intro === it.id || sl.options.some(o => o.intro === it.id)));
    assert.ok(used, 'introduction sans exercice ' + it.id);
  });
});


test('poussée : pompes sur les poings dès le départ, développé au sol en semaine 4', () => {
  const s = fresh();
  assert.ok(E.sessionPlan(s, plan, 'B').some(i => i.key === 'B6'));
  assert.ok(E.sessionPlan(s, plan, 'D').some(i => i.key === 'D6'));
  s.intros.wallSit = 1;
  clock += 5;
  tolerated(s, 'D', [19]);
  tolerated(s, 'C', [16]);
  assert.strictEqual(E.introProposal(s, plan, D(20)), null, 'avant la semaine 4');
  const p = E.introProposal(s, plan, D(21));
  assert.ok(p && p.intro.id === 'floorPress');
  E.applyDecision(s, plan, p, true, null, clock++, D(21));
  const d = E.sessionPlan(s, plan, 'D').map(i => i.key);
  assert.ok(d.includes('D6p') && !d.includes('D6'));
});

test('stepDown suit le développé au sol, pas avant le 2 novembre', () => {
  const s = fresh();
  s.intros.wallSit = 1; s.intros.floorPress = 2;
  clock += 5;
  tolerated(s, 'D', [33]);
  assert.strictEqual(E.introProposal(s, plan, '2026-11-01'), null);
  tolerated(s, 'D', [35]);
  const p = E.introProposal(s, plan, '2026-11-03');
  assert.ok(p && p.intro.id === 'stepDown');
});

test('séjour ski : pas de montée ni de nouvel exercice pendant la semaine allégée, le séjour et la reprise', () => {
  const s = fresh();
  ['2026-12-10', '2026-12-14', '2026-12-17'].forEach(d => { ck(s, d, 3, 3); sess(s, d, 'A'); ck(s, E.addDays(d, 1), 3, 3); });
  assert.ok(E.upProposal(s, plan, 'A', '2026-12-18'));
  assert.strictEqual(E.upProposal(s, plan, 'A', '2026-12-22'), null, 'semaine allégée');
  assert.strictEqual(E.upProposal(s, plan, 'A', '2026-12-30'), null, 'séjour');
  assert.strictEqual(E.upProposal(s, plan, 'A', '2027-01-06'), null, 'reprise');
  assert.ok(E.upProposal(s, plan, 'A', '2027-01-11'), 'la progression reprend');
});

test('séjour ski : routine du matin les jours de ski, rien les jours de vol', () => {
  const s = fresh();
  assert.strictEqual(E.suggestion(s, plan, '2026-12-27'), null, 'vol aller');
  assert.strictEqual(E.suggestion(s, plan, '2026-12-28'), 'S');
  sess(s, '2026-12-28', 'S');
  assert.strictEqual(E.suggestion(s, plan, '2026-12-28'), null, 'déjà faite');
  assert.strictEqual(E.suggestion(s, plan, '2027-01-03'), null, 'vol retour');
  assert.ok(E.visibleTypes(plan, '2026-12-29').includes('S'));
  assert.ok(!E.visibleTypes(plan, '2026-12-20').includes('S'));
});

test('séjour ski : la semaine compte pour la série', () => {
  const s = E.emptyState('2026-12-14'); s.settings.setup = true;
  ['A', 'B', 'A', 'C'].forEach((t, i) => sess(s, E.addDays('2026-12-14', i), t));
  ['A', 'B', 'A', 'C'].forEach((t, i) => sess(s, E.addDays('2026-12-21', i), t));
  const st = E.streakInfo(s, plan, '2027-01-04');
  assert.strictEqual(st.streak, 3);
  assert.strictEqual(E.weekRemaining(s, plan, '2026-12-30').length, 0);
});

test('poussée après une journée de ski : information, pas de baisse', () => {
  const s = fresh();
  for (let i = 1; i <= 7; i++) ck(s, E.addDays('2026-12-28', -i), 3, 3);
  ck(s, '2026-12-28', 3, 3);
  sess(s, '2026-12-28', 'S');
  ck(s, '2026-12-29', 7, 3);
  const p = E.flareProposals(s, plan, '2026-12-29');
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, 'info');
});

test('jalon du 15 novembre : affiché jusqu\'au 30, une seule fois', () => {
  const s = fresh();
  assert.strictEqual(E.milestoneCards(s, plan, '2026-11-14').length, 0);
  const c = E.milestoneCards(s, plan, '2026-11-15');
  assert.strictEqual(c.length, 1);
  E.applyDecision(s, plan, c[0], true, null, clock++, '2026-11-15');
  assert.strictEqual(E.milestoneCards(s, plan, '2026-11-16').length, 0);
  assert.strictEqual(E.milestoneCards(fresh(), plan, '2026-12-01').length, 0, 'périmé');
});

console.log('\n' + passed + ' tests réussis.');
