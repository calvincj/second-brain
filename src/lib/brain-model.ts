import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { MapEdge, MapNode } from "@/lib/types";

// Bioluminescent palette: readable glows on a near-black background.
export const REGION_COLORS = ["#2de2c8", "#9b7bff", "#ffb347", "#ff6fb5", "#4cc9ff", "#b6f36b", "#ff8a65", "#ffd166"];
export const LONE_COLOR = "#7d84a8";

// Positions are undefined (not null) until placed: d3 reads null as 0.
export type BrainNode = Omit<MapNode, "x" | "y" | "z"> & {
  region: number | null; // index into regions, null = unconnected
  color: string;
  degree: number;
  x?: number;
  y?: number;
  z?: number;
  // Set by the force simulation.
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
};

export type BrainLink = { source: string | BrainNode; target: string | BrainNode; weight: number; key: string };

export type Region = { id: number; name: string; color: string; members: string[] };

export type BrainModel = { nodes: BrainNode[]; links: BrainLink[]; regions: Region[] };

// Links kept per thought. Measured on real Voyage embeddings, a thought's
// nearest 1-2 neighbours are on-topic ~85% of the time; accuracy falls after.
export function defaultK(nodeCount: number) {
  return Math.max(1, Math.min(3, Math.round(nodeCount / 15)));
}

// Keep each thought's strongest few links, then drop the weakest of those
// relative to the corpus, so regions stay distinct instead of one blob.
export function selectEdges(nodeCount: number, edges: MapEdge[], k = defaultK(nodeCount)): MapEdge[] {
  const bySource = new Map<string, MapEdge[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    const list = bySource.get(e.source) ?? [];
    list.push(e);
    bySource.set(e.source, list);
  }
  const kept: MapEdge[] = [];
  for (const list of bySource.values()) {
    list.sort((a, b) => b.similarity - a.similarity);
    kept.push(...list.slice(0, k));
  }
  if (kept.length === 0) return [];
  const sims = kept.map((e) => e.similarity).sort((a, b) => a - b);
  const cutoff = sims[Math.floor(sims.length * 0.3)];
  return kept.filter((e) => e.similarity >= cutoff);
}

// Deterministic RNG so the same brain gets the same regions (and colours)
// every time it's opened.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STOPWORDS = new Set(
  "a an the of to in on for and or but is are was were be been it its this that with as at by from than then so about into over under more most less least very can could would should will just not no yes do does did has have had their there they them you your we our he she his her which who whom what when where why how per vs".split(
    " ",
  ),
);

// Words too generic to name a region after ("Years", "Two", "People").
const GENERIC = new Set(
  "one two three four five six seven eight nine ten hundred thousand million billion trillion half third percent times time year years day days week weeks month months hour hours minute minutes second seconds people person thing things way ways part parts lot lots kind kinds number numbers average around nearly almost only also even still every each other another first last next new old older newer large larger largest small smaller big bigger biggest high higher low lower long longer short more most less least many much few after before during while since because however although like than then there here make makes made take takes took get gets got use uses used called known found seen say says said due about over under into across between same different whole entire world blue red green black white".split(
    " ",
  ),
);

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Candidate names for a region, best first: its common tags, then the words
// most distinctive to it compared with the whole brain.
export function regionNameCandidates(members: MapNode[], all: MapNode[]): string[] {
  const tagCounts = new Map<string, number>();
  for (const m of members) for (const t of m.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts.entries()]
    .filter(([, c]) => c >= Math.max(2, members.length * 0.4))
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  const words = (nodes: MapNode[]) => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const seen = new Set(
        (n.caption.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w)),
      );
      for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    return counts;
  };
  const local = words(members);
  const global = words(all);
  const distinctive = [...local.entries()]
    .filter(([, c]) => c >= 2)
    .map(([w, c]) => ({ w, score: (c / members.length) * Math.log(all.length / (global.get(w) ?? 1)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.w);

  const anyTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  // When no single tag covers most of the region, a pair describes it better.
  const pairs: string[] = [];
  if (tags.length >= 2 && (tagCounts.get(tags[0]) ?? 0) < members.length * 0.6) pairs.push(`${tags[0]} & ${tags[1]}`);
  return [...new Set([...pairs, ...tags, ...distinctive, ...anyTags])].map(titleCase);
}

// Unique names across regions (bigger regions pick first).
function nameRegions(groups: string[][], byId: Map<string, MapNode>, all: MapNode[]): string[] {
  const used = new Set<string>();
  return groups.map((members) => {
    const candidates = regionNameCandidates(
      members.map((m) => byId.get(m)!),
      all,
    );
    let name = candidates.find((c) => !used.has(c));
    if (!name) {
      const base = candidates[0] ?? "Region";
      let i = 2;
      while (used.has(`${base} ${i}`)) i++;
      name = `${base} ${i}`;
    }
    used.add(name);
    return name;
  });
}

// A region keeps its colour as it grows or shrinks: the colour comes from a
// hash of one of its members (the smallest id), not from its size rank.
// Collisions take the next free colour.
function stableColors(groups: string[][]): string[] {
  const used = new Set<number>();
  return groups.map((members) => {
    const anchor = [...members].sort()[0];
    let h = 0;
    for (let i = 0; i < anchor.length; i++) h = (Math.imul(h, 31) + anchor.charCodeAt(i)) | 0;
    let idx = Math.abs(h) % REGION_COLORS.length;
    for (let k = 0; k < REGION_COLORS.length && used.has(idx); k++) idx = (idx + 1) % REGION_COLORS.length;
    used.add(idx);
    return REGION_COLORS[idx];
  });
}

export function buildBrain(nodes: MapNode[], edges: MapEdge[]): BrainModel {
  const ids = new Set(nodes.map((n) => n.id));
  const graph = new Graph({ type: "undirected" });
  nodes.forEach((n) => graph.addNode(n.id));

  // Union of both directions; keep the stronger similarity for a pair.
  // Drop edges to missing (e.g. just-deleted) thoughts first, so they can't
  // take up a thought's few link slots.
  const live = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  for (const e of selectEdges(nodes.length, live)) {
    if (graph.hasEdge(e.source, e.target)) {
      const w = graph.getEdgeAttribute(e.source, e.target, "weight") as number;
      if (e.similarity > w) graph.setEdgeAttribute(e.source, e.target, "weight", e.similarity);
    } else {
      graph.addEdge(e.source, e.target, { weight: e.similarity });
    }
  }

  // Regions = communities of at least two connected thoughts.
  const community: Record<string, number> =
    graph.size > 0 ? louvain(graph, { getEdgeWeight: "weight", rng: mulberry32(7) }) : {};
  const groups = new Map<number, string[]>();
  for (const n of nodes) {
    if (graph.degree(n.id) === 0 || community[n.id] == null) continue;
    const list = groups.get(community[n.id]) ?? [];
    list.push(n.id);
    groups.set(community[n.id], list);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Real regions have at least 3 thoughts (2 with a tiny brain). Connected
  // thoughts left outside one join the region of their strongest neighbour,
  // so nothing that clearly belongs somewhere shows up as "Unsorted".
  const minSize = nodes.length < 12 ? 2 : 3;
  const regionGroups = [...groups.values()].filter((m) => m.length >= minSize);
  const groupOf = new Map<string, string[]>();
  regionGroups.forEach((g) => g.forEach((id) => groupOf.set(id, g)));
  // Only a genuinely strong link pulls a straggler into a region; weak ones
  // dragged unrelated facts in (history facts landing in "Space").
  const allWeights = graph.mapEdges((_, a) => a.weight as number).sort((a, b) => a - b);
  const attachMin = allWeights.length ? allWeights[Math.floor(allWeights.length / 2)] : 0;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const n of nodes) {
      if (groupOf.has(n.id) || graph.degree(n.id) === 0) continue;
      let best: string[] | undefined;
      let bestWeight = -1;
      graph.forEachEdge(n.id, (_, a, s, t) => {
        const other = s === n.id ? t : s;
        const g = groupOf.get(other);
        if (g && (a.weight as number) > bestWeight) {
          best = g;
          bestWeight = a.weight as number;
        }
      });
      if (best && bestWeight >= attachMin) {
        best.push(n.id);
        groupOf.set(n.id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // "Move to region": a pinned thought joins its anchor's region (or leaves
  // regions entirely when pinned to itself).
  for (const n of nodes) {
    if (!n.regionAnchor) continue;
    const from = groupOf.get(n.id);
    const to = n.regionAnchor === n.id ? undefined : groupOf.get(n.regionAnchor);
    if (from === to) continue;
    if (from) from.splice(from.indexOf(n.id), 1);
    if (to) to.push(n.id);
    groupOf.delete(n.id);
    if (to) groupOf.set(n.id, to);
  }
  const sortedGroups = regionGroups.filter((g) => g.length > 0).sort((a, b) => b.length - a.length);
  const names = nameRegions(sortedGroups, byId, nodes);
  const colors = stableColors(sortedGroups);
  const regions: Region[] = sortedGroups.map((members, i) => ({
    id: i,
    name: names[i],
    color: colors[i],
    members,
  }));
  const regionOf = new Map<string, number>();
  regions.forEach((r) => r.members.forEach((m) => regionOf.set(m, r.id)));

  const brainNodes: BrainNode[] = nodes.map((n) => {
    const region = regionOf.get(n.id) ?? null;
    return {
      id: n.id,
      caption: n.caption,
      tags: n.tags,
      embedded: n.embedded,
      createdAt: n.createdAt,
      lastViewedAt: n.lastViewedAt,
      regionAnchor: n.regionAnchor,
      x: n.x ?? undefined,
      y: n.y ?? undefined,
      z: n.z ?? undefined,
      region,
      color: region == null ? LONE_COLOR : regions[region].color,
      degree: graph.degree(n.id),
    };
  });

  // Normalise weights to 0..1 within this brain (raw cosine is compressed).
  const weights = graph.mapEdges((_, a) => a.weight as number);
  const lo = Math.min(...weights);
  const hi = Math.max(...weights);
  const links: BrainLink[] = graph.mapEdges((key, a, source, target) => ({
    key,
    source,
    target,
    weight: hi > lo ? 0.3 + (0.7 * ((a.weight as number) - lo)) / (hi - lo) : 1,
  }));

  return { nodes: brainNodes, links, regions };
}

export type Activation = { id: string; level: number; hop: number; from: string | null };

// Spreading activation: search hits ignite, and the signal travels outward
// along connections, weakening with each hop and with weaker links.
export function spreadActivation(
  seeds: string[],
  links: BrainLink[],
  { hops = 2, decay = 0.6 }: { hops?: number; decay?: number } = {},
): Map<string, Activation> {
  const adjacency = new Map<string, { id: string; weight: number }[]>();
  for (const l of links) {
    const s = typeof l.source === "string" ? l.source : l.source.id;
    const t = typeof l.target === "string" ? l.target : l.target.id;
    adjacency.set(s, [...(adjacency.get(s) ?? []), { id: t, weight: l.weight }]);
    adjacency.set(t, [...(adjacency.get(t) ?? []), { id: s, weight: l.weight }]);
  }

  const result = new Map<string, Activation>();
  seeds.forEach((id, rank) => {
    const level = Math.max(0.55, 1 - rank * 0.08);
    if (!result.has(id) || result.get(id)!.level < level) result.set(id, { id, level, hop: 0, from: null });
  });

  let frontier = [...result.values()];
  for (let hop = 1; hop <= hops; hop++) {
    const next: Activation[] = [];
    for (const a of frontier) {
      for (const n of adjacency.get(a.id) ?? []) {
        const level = a.level * decay * n.weight;
        if (level < 0.12) continue;
        const existing = result.get(n.id);
        if (existing && existing.level >= level) continue;
        const act = { id: n.id, level, hop, from: a.id };
        result.set(n.id, act);
        next.push(act);
      }
    }
    frontier = next;
  }
  return result;
}
