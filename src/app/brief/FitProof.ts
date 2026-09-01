/**
 * « Ajuste pour moi » — la preuve par les chiffres (v294).
 *
 * Après qu'une suggestion du Bilan du tombé a été appliquée et que le tissu
 * s'est reposé, on compare les MESURES du solveur avant/après, zone par zone.
 * Aucune IA ici : le verdict vient des mesures, jamais de la parole du
 * conseiller. Module pur (pas de DOM) pour être testé tel quel.
 */

interface ZoneMetrics {
  zone: string;
  aisanceMin?: number;
  etirementP95?: number;
}

/** Extraction tolérante d'un rapport `collectFitReport` (forme non typée). */
function readZones(report: unknown): ZoneMetrics[] {
  const zones = (report as { zones?: unknown } | null)?.zones;
  if (!Array.isArray(zones)) return [];
  const out: ZoneMetrics[] = [];
  for (const rawZone of zones) {
    const z = rawZone as Record<string, unknown>;
    if (typeof z?.zone !== 'string') continue;
    const aisance = z.aisanceMm as { min?: unknown } | undefined;
    const etirement = z.etirementPct as { p95?: unknown } | undefined;
    out.push({
      zone: z.zone,
      ...(typeof aisance?.min === 'number' ? { aisanceMin: aisance.min } : {}),
      ...(typeof etirement?.p95 === 'number' ? { etirementP95: etirement.p95 } : {}),
    });
  }
  return out;
}

function readSeamOverMax(report: unknown): number | undefined {
  const coutures = (report as { coutures?: { surTensionMaxMm?: unknown } } | null)?.coutures;
  return typeof coutures?.surTensionMaxMm === 'number' ? coutures.surTensionMaxMm : undefined;
}

const fr = (v: number): string => String(Math.round(v * 10) / 10).replace('.', ',');

/** « 1,2 → 24 mm (+22,8) » — le delta signé rend le sens de lecture immédiat. */
function evolution(avant: number, apres: number, unite: string): string {
  const delta = Math.round((apres - avant) * 10) / 10;
  const signe = delta > 0 ? `+${fr(delta)}` : fr(delta);
  return `${fr(avant)} → ${fr(apres)} ${unite} (${delta === 0 ? '=' : signe})`;
}

/**
 * Les lignes de preuve, une par zone présente dans les DEUX rapports (une zone
 * qui apparaît ou disparaît n'est pas comparable — on ne l'invente pas).
 * L'ordre suit le rapport d'avant (épaules → bas), les coutures ferment.
 */
export function fitProofLines(avant: unknown, apres: unknown): string[] {
  const zonesAvant = readZones(avant);
  const zonesApres = new Map(readZones(apres).map((z) => [z.zone, z]));
  const lines: string[] = [];
  for (const za of zonesAvant) {
    const zb = zonesApres.get(za.zone);
    if (!zb) continue;
    const parts: string[] = [];
    if (za.aisanceMin !== undefined && zb.aisanceMin !== undefined) {
      parts.push(`aisance min ${evolution(za.aisanceMin, zb.aisanceMin, 'mm')}`);
    }
    if (za.etirementP95 !== undefined && zb.etirementP95 !== undefined) {
      parts.push(`étirement p95 ${evolution(za.etirementP95, zb.etirementP95, '%')}`);
    }
    if (parts.length) lines.push(`${za.zone} — ${parts.join(' · ')}`);
  }
  const seamAvant = readSeamOverMax(avant);
  const seamApres = readSeamOverMax(apres);
  if (seamAvant !== undefined && seamApres !== undefined) {
    lines.push(`coutures — sur-tension max ${evolution(seamAvant, seamApres, 'mm')}`);
  }
  return lines;
}
