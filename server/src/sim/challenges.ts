// Challenge mode (P4): scoreboards with teeth. A challenge wraps the live
// world in hard constraints — budget, availability or recovery time — and
// grades you daily. Pure catalog + math here; the stateful run lives in
// world.ts (startChallenge / tickChallenge).

export type ChallengeRule = 'budget' | 'availability' | 'rto';

export interface ChallengeDef {
  id: string;
  name: string;
  tagline: string;
  rule: ChallengeRule;
  durationDays: number;
  /** budget: how much of the starting bill you must cut (0.18 → cap = 82%) */
  requiredCutPct?: number;
  /** availability: windowed floor you must hold (99.5 → ~14 bad min over 2 days) */
  availabilityFloorPct?: number;
  /** rto: minutes from disaster to a verified restore */
  rtoTargetMin?: number;
  /** rto: the disaster lands at a random minute inside this window */
  disasterWindowMin?: [number, number];
  briefing: string;
  ruleLabel: string;
  scoreLabel: string;
}

export const CHALLENGES: ChallengeDef[] = [
  {
    id: 'budget-blitz',
    name: 'The austerity clause',
    tagline: 'The board mandates an 18% cut, effective yesterday.',
    rule: 'budget',
    durationDays: 2,
    requiredCutPct: 0.18,
    briefing: 'Investors attached a rider to the round: the infra bill comes down 18% and STAYS down for two sim days. Levers you already know: rightsizing, reserved compute, decommissioning relics, a cheaper provider. The cap is measured against the bill the moment you accept.',
    ruleLabel: 'Keep the monthly bill at or below 82% of today\'s, every day, for 2 sim days.',
    scoreLabel: '% under the cap'
  },
  {
    id: 'four-nines',
    name: 'The renewal audit',
    tagline: 'The enterprise contract renews only if the uptime does.',
    rule: 'availability',
    durationDays: 2,
    availabilityFloorPct: 99.5,
    briefing: 'The enterprise customer\'s auditors are watching for two sim days. Windowed availability — measured from the moment you accept, not from history — must stay at or above 99.5%. That is ~14 bad minutes over two days. A provider outage, a full disk, a reckless deploy: any of them spends the whole budget. The world will not go quiet just because you are being graded (a failover drill is scheduled — consider it a pop quiz).',
    ruleLabel: 'Hold ≥ 99.5% windowed availability for 2 sim days (~14 bad minutes total).',
    scoreLabel: 'windowed availability %'
  },
  {
    id: 'back-from-dead',
    name: 'The auditors pull the plug',
    tagline: 'A data-destroying disaster, at a time you do not know.',
    rule: 'rto',
    durationDays: 1.5,
    rtoTargetMin: 120,
    disasterWindowMin: [180, 540],
    briefing: 'Sometime in the next 3–9 sim hours, the orders table gets dropped. You will not be warned. Recover from YOUR backups with RTO ≤ 120 minutes and RPO ≤ 24h — prove it with a restore, not a promise. If you have no usable snapshot from before the disaster, the provider\'s emergency recovery takes over: 19 hours, a support fee, and a failed challenge.',
    ruleLabel: 'Restore the dropped orders within 120 min of the disaster (RPO ≤ 24h).',
    scoreLabel: 'restore minutes (lower is better)'
  }
];

export function challengeOf(id: string): ChallengeDef | null {
  return CHALLENGES.find((c) => c.id === id) ?? null;
}

/** Monthly bill cap for a budget challenge, given the bill at acceptance. */
export function budgetCapOf(def: ChallengeDef, startBill: number): number {
  const cut = def.requiredCutPct ?? 0;
  return Math.round(startBill * (1 - cut));
}

/**
 * Availability measured inside the challenge window only: how many minutes
 * above 5% errors did the platform log since the challenge started, as a
 * percentage of the window elapsed so far.
 */
export function windowedAvailability(badMinDelta: number, windowMin: number): number {
  const window = Math.max(1, windowMin);
  return Math.max(0, 100 - (Math.max(0, badMinDelta) / window) * 100);
}

/** Stars for the scoreboard: 3 = exemplary, 2 = clean pass, 1 = scraped by.
 *  Budget score = cut achieved (percentage of the starting bill removed). */
export function challengeStars(rule: ChallengeRule, score: number, def: ChallengeDef): number {
  if (rule === 'budget') {
    const cutPct = (def.requiredCutPct ?? 0) * 100;
    if (score >= cutPct + 8) return 3; // beat the mandate by ≥8 points
    if (score >= cutPct + 3) return 2;
    return 1;
  }
  if (rule === 'availability') {
    const floor = def.availabilityFloorPct ?? 99.5;
    if (score >= floor + 0.35) return 3;
    if (score >= floor + 0.1) return 2;
    return 1;
  }
  const target = def.rtoTargetMin ?? 120;
  if (score <= target * 0.5) return 3;
  if (score <= target * 0.8) return 2;
  return 1;
}
