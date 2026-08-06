import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convictionTier, convictionRisk, normalizeTiers, CONVICTION_TIERS,
} from './convictionSizing.js';

const setup = (o = {}) => ({ grade: 'A+', score: 90, rr: 3, ...o });

// ── the ladder ───────────────────────────────────────────────────────────────

test('a setup clearing every bar earns full size', () => {
  const t = convictionTier(setup());
  assert.equal(t.tier, 'FULL');
  assert.equal(t.fraction, 1);
});

test('weaker setups step down the ladder', () => {
  assert.equal(convictionTier(setup({ grade: 'A', score: 80, rr: 2.2 })).tier, 'HIGH');
  assert.equal(convictionTier(setup({ grade: 'A', score: 72, rr: 1.9 })).tier, 'NORMAL');
  assert.equal(convictionTier(setup({ grade: 'B', score: 65, rr: 1.6 })).tier, 'STARTER');
  assert.equal(convictionTier(setup({ grade: 'C', score: 40, rr: 1.1 })).tier, 'MINIMUM');
});

test('EVERY bar must clear — one strong input cannot carry a weak one', () => {
  // A 95-score A+ with a 1.2R draw is not a full-size trade: the reward cannot pay for the risk
  // however clean the pattern looks. Averaging the criteria would let the score hide the R:R.
  const t = convictionTier(setup({ grade: 'A+', score: 95, rr: 1.2 }));
  assert.notEqual(t.tier, 'FULL');
  // 1.2R clears no tier above MINIMUM — STARTER still asks for 1.5R. The R:R alone drops a
  // 95-score A+ all the way to the bottom, which is the point.
  assert.equal(t.tier, 'MINIMUM');
  const rescued = convictionTier(setup({ grade: 'A+', score: 95, rr: 1.6 }));
  assert.equal(rescued.tier, 'STARTER', 'lifting only the R:R lifts the tier');
});

test('a high R:R cannot rescue a poor grade', () => {
  const t = convictionTier(setup({ grade: 'C', score: 55, rr: 6 }));
  assert.equal(t.tier, 'MINIMUM');
});

test('missing quality inputs fall to the bottom rather than defaulting to full', () => {
  // A missing score must never be read as a perfect one — that would put unknown setups at max
  // size, which is the exact behaviour this module exists to remove.
  assert.equal(convictionTier({}).tier, 'MINIMUM');
  assert.equal(convictionTier({ grade: null, score: null, rr: null }).tier, 'MINIMUM');
  assert.equal(convictionTier({ grade: 'A+', score: null, rr: 3 }).tier, 'MINIMUM');
});

test('a zero score is a real score, not a missing one', () => {
  // Number(null) is 0 and 0 is finite; conflating them would grade "unknown" as "worst".
  const t = convictionTier({ grade: 'C', score: 0, rr: 1 });
  assert.equal(t.tier, 'MINIMUM');
});

test('every tier decision carries a reason', () => {
  assert.ok(convictionTier(setup()).why.length > 5);
  assert.match(convictionTier(setup({ rr: 1.1 })).why, /R/);
});

// ── the money ────────────────────────────────────────────────────────────────

test('conviction scales the budget down, and the ceiling always binds', () => {
  assert.equal(convictionRisk(setup(), 80).riskUsd, 80, 'full size takes the whole budget');
  assert.equal(convictionRisk(setup({ grade: 'A', score: 80, rr: 2.2 }), 80).riskUsd, 60);
  assert.equal(convictionRisk(setup({ grade: 'A', score: 72, rr: 1.9 }), 80).riskUsd, 40);
  assert.equal(convictionRisk(setup({ grade: 'B', score: 65, rr: 1.6 }), 80).riskUsd, 24);
  assert.equal(convictionRisk(setup({ grade: 'C', score: 40, rr: 1 }), 80).riskUsd, 16);
});

test('conviction can NEVER raise risk above the configured budget', () => {
  // A "high conviction" override that risked more than configured would defeat the point of
  // configuring it.
  for (const s of [setup(), setup({ score: 100, rr: 99 })]) {
    const r = convictionRisk(s, 40);
    assert.ok(r.riskUsd <= 40, `${r.riskUsd} must not exceed the $40 budget`);
  }
});

test('the amount held back is reported, so the behaviour is visible', () => {
  const r = convictionRisk(setup({ grade: 'B', score: 65, rr: 1.6 }), 80);
  assert.equal(r.riskUsd, 24);
  assert.equal(r.heldBackUsd, 56);
  assert.equal(r.budget, 80);
});

test('the budget scales everything — changing Account & Sizing changes every tier', () => {
  // The user set 0.4% of $10,000; every tier must follow that number, not a hardcoded one.
  const at = (budget) => convictionRisk(setup({ grade: 'A', score: 80, rr: 2.2 }), budget).riskUsd;
  assert.equal(at(80), 60);
  assert.equal(at(40), 30);
  assert.equal(at(20), 15);
});

test('a floor stops a low tier collapsing under the broker minimum', () => {
  // Below the smallest position the broker accepts, lots round back UP and silently undo the cut.
  const r = convictionRisk(setup({ grade: 'C', score: 30, rr: 1 }), 80, { floorUsd: 25 });
  assert.equal(r.riskUsd, 25);
  assert.equal(r.flooredAt, 25);
});

test('the floor can never push risk above the budget either', () => {
  const r = convictionRisk(setup({ grade: 'C', score: 30, rr: 1 }), 20, { floorUsd: 50 });
  assert.equal(r.riskUsd, 20, 'the budget still wins');
});

test('disabled means every setup takes the full budget, as before', () => {
  const r = convictionRisk(setup({ grade: 'C', score: 10, rr: 1 }), 80, { enabled: false });
  assert.equal(r.riskUsd, 80);
  assert.equal(r.tier, 'FULL');
  assert.match(r.why, /conviction sizing is off/);
});

test('no budget yields no risk, never a guessed default', () => {
  for (const bad of [null, undefined, 0, -5, '']) {
    assert.equal(convictionRisk(setup(), bad).riskUsd, null);
  }
});

// ── user-edited ladders ──────────────────────────────────────────────────────

test('a fraction above 1 is clamped — a bad edit cannot exceed the budget', () => {
  const t = normalizeTiers([{ key: 'X', fraction: 5, minScore: 0, minGrade: 'C', minRr: 0 }]);
  assert.equal(t[0].fraction, 1);
  assert.ok(convictionRisk(setup(), 80, { tiers: t }).riskUsd <= 80);
});

test('tiers are sorted strictest-first so the first match is the highest earned', () => {
  const t = normalizeTiers([
    { key: 'LOW', fraction: 0.2, minScore: 0, minGrade: 'C', minRr: 0 },
    { key: 'TOP', fraction: 1, minScore: 90, minGrade: 'A+', minRr: 3 },
  ]);
  assert.equal(t[0].key, 'TOP');
  assert.equal(convictionRisk(setup(), 80, { tiers: t }).tier, 'TOP');
});

test('a malformed ladder falls back to the built-in one', () => {
  assert.deepEqual(normalizeTiers(null), CONVICTION_TIERS);
  assert.deepEqual(normalizeTiers([]), CONVICTION_TIERS);
});

test('nonsense tier fields are coerced to something usable', () => {
  const t = normalizeTiers([{ key: 'A', fraction: 'abc', minScore: 500, minGrade: 'Z', minRr: -3 }]);
  assert.ok(t[0].fraction > 0 && t[0].fraction <= 1);
  assert.equal(t[0].minScore, 100);
  assert.equal(t[0].minGrade, 'C');
  assert.equal(t[0].minRr, 0);
});
