// Fictional cloud providers — the P3 ecosystem. Pure data & math only:
// the stateful lifecycle (outages, migrations, credits) lives in world.ts.
//
// The tradeoff triangle: Stratus is the baseline incumbent, Volt is cheap
// but flaky, Orbit is expensive and boringly reliable. Regions trade price
// against latency to your users.

export interface CloudRegion {
  id: string;
  name: string;
  latencyMs: number;   // round-trip to your users (mostly US)
  priceMult: number;   // region price multiplier
}

export interface CloudProvider {
  id: 'stratus' | 'volt' | 'orbit';
  name: string;
  tagline: string;
  priceMult: number;         // provider price multiplier
  reliabilityPct: number;    // advertised monthly uptime SLA
  outageChancePerDay: number; // ambient provider-outage probability
  creditMultiplier: number;  // SLA credit generosity (× a day of bill per outage-day fraction)
  regions: CloudRegion[];
}

export const PROVIDERS: Record<string, CloudProvider> = {
  stratus: {
    id: 'stratus',
    name: 'Stratus Cloud',
    tagline: 'the incumbent: list price, 99.9%, a sales rep who golfs',
    priceMult: 1.0,
    reliabilityPct: 99.9,
    outageChancePerDay: 0.05,
    creditMultiplier: 10,
    regions: [
      { id: 'us-east-1', name: 'us-east-1 (Ashburn)', latencyMs: 22, priceMult: 1.0 },
      { id: 'us-west-1', name: 'us-west-1 (Portland)', latencyMs: 68, priceMult: 1.05 },
      { id: 'eu-west-1', name: 'eu-west-1 (Dublin)', latencyMs: 118, priceMult: 0.95 }
    ]
  },
  volt: {
    id: 'volt',
    name: 'Volt Compute',
    tagline: '28% cheaper, 99.5% SLA: the budget cloud with opinions',
    priceMult: 0.72,
    reliabilityPct: 99.5,
    outageChancePerDay: 0.18,
    creditMultiplier: 5,
    regions: [
      { id: 'us-central-1', name: 'us-central-1 (Des Moines)', latencyMs: 45, priceMult: 1.0 },
      { id: 'eu-north-1', name: 'eu-north-1 (Stockholm)', latencyMs: 140, priceMult: 0.9 }
    ]
  },
  orbit: {
    id: 'orbit',
    name: 'Orbit Systems',
    tagline: 'premium: 99.99%, 30× SLA credits, invoice stickers on everything',
    priceMult: 1.3,
    reliabilityPct: 99.99,
    outageChancePerDay: 0.008,
    creditMultiplier: 30,
    regions: [
      { id: 'us-east-2', name: 'us-east-2 (Arlington)', latencyMs: 20, priceMult: 1.0 },
      { id: 'ap-southeast-1', name: 'ap-southeast-1 (Singapore)', latencyMs: 160, priceMult: 1.15 }
    ]
  }
};

/** Latency baseline baked into the original p95 math (Stratus us-east-1). */
export const BASE_LATENCY_MS = 22;

export function providerOf(id: string): CloudProvider {
  return PROVIDERS[id] ?? PROVIDERS.stratus;
}

export function regionOf(providerId: string, regionId: string): CloudRegion {
  const p = providerOf(providerId);
  return p.regions.find((r) => r.id === regionId) ?? p.regions[0];
}

export function isRegion(providerId: string, regionId: string): boolean {
  return PROVIDERS[providerId]?.regions.some((r) => r.id === regionId) ?? false;
}

/** Combined price multiplier of a provider+region footprint. */
export function costMultiplierOf(providerId: string, regionId: string): number {
  return providerOf(providerId).priceMult * regionOf(providerId, regionId).priceMult;
}

/** Latency to users from a footprint (defaults to the pre-P3 baseline). */
export function latencyMsOf(providerId: string | undefined, regionId: string | undefined): number {
  if (!providerId || !regionId) return BASE_LATENCY_MS;
  return regionOf(providerId, regionId).latencyMs;
}

/**
 * Planned cutover downtime for a migration — every preparation the player
 * already made (backups, staging, LB, k8s) shortens the outage.
 */
export function plannedDowntimeMin(hasBackups: boolean, hasStaging: boolean, hasLb: boolean, hasK8s: boolean): number {
  let d = 45;
  if (hasBackups) d -= 10;
  if (hasStaging) d -= 10;
  if (hasLb) d -= 10;
  if (hasK8s) d -= 5;
  return Math.max(5, d);
}

/**
 * SLA credit for an outage: the fraction of a day the outage covered, times
 * the monthly bill, times the provider's credit generosity. An Orbit blip
 * pays for itself; a Volt brownout buys lunch.
 */
export function slaCreditFor(monthlyCost: number, durationMin: number, providerId: string): number {
  const mult = providerOf(providerId).creditMultiplier;
  return Math.round(monthlyCost * (durationMin / 1440) * mult);
}

/** One-time migration cost: ~15% of the monthly bill, $500 minimum. */
export function migrationCostOf(monthlyCost: number): number {
  return Math.max(500, Math.round(monthlyCost * 0.15));
}

export const MIGRATION_DURATION_MIN = 360; // 6 sim hours of prep + replicate
