import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { MapEdge, MapNode } from "@/lib/types";

export type NodeAttrs = {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  caption: string;
  tags: string[];
  // Unembedded logs sit in a ring at the edge and don't move.
  fixed: boolean;
  parked: boolean;
  // True when this node had no saved position and was placed this session.
  placed: boolean;
  community?: number;
};

export type EdgeAttrs = { weight: number; size: number; color: string };

export type BrainGraph = Graph<NodeAttrs, EdgeAttrs>;

// Categorical palette (mid-tone, readable on both light and dark backgrounds).
const PALETTE = ["#7c5cff", "#16a3b8", "#e0732f", "#2fa86a", "#d64b8a", "#c9a227", "#4c7fe0", "#a0522d"];
const LONE_COLOR = "#8d8da3";

function truncate(text: string, max = 42) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Links kept per log. Measured on real Voyage embeddings, a log's nearest 1-2
// neighbours are on-topic ~85% of the time and accuracy falls off after that.
export function defaultK(nodeCount: number) {
  return Math.max(1, Math.min(3, Math.round(nodeCount / 15)));
}

// Keep each log's strongest few links, then drop the weakest of those relative
// to the corpus, so clusters stay distinct instead of becoming one blob.
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

export function buildGraph(nodes: MapNode[], edges: MapEdge[], k?: number): BrainGraph {
  const graph: BrainGraph = new Graph({ type: "undirected", allowSelfLoops: false });
  const ids = new Set(nodes.map((n) => n.id));

  for (const n of nodes) {
    graph.addNode(n.id, {
      x: n.x ?? 0,
      y: n.y ?? 0,
      size: 4,
      label: truncate(n.caption),
      color: LONE_COLOR,
      caption: n.caption,
      tags: n.tags,
      fixed: false,
      parked: !n.embedded,
      placed: n.embedded && (n.x == null || n.y == null),
    });
  }

  // Union of both directions; keep the stronger similarity for a pair.
  for (const e of selectEdges(nodes.length, edges, k)) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (graph.hasEdge(e.source, e.target)) {
      const w = graph.getEdgeAttribute(e.source, e.target, "weight");
      if (e.similarity > w) graph.setEdgeAttribute(e.source, e.target, "weight", e.similarity);
    } else {
      graph.addEdge(e.source, e.target, { weight: e.similarity, size: 1, color: LONE_COLOR });
    }
  }

  graph.forEachNode((id, a) => {
    graph.setNodeAttribute(id, "size", 3.5 + Math.min(6, Math.sqrt(graph.degree(id)) * 1.6) + (a.parked ? -1 : 0));
  });

  placeNodes(graph);
  colorCommunities(graph);
  return graph;
}

// Seed positions for nodes without a saved one, so a layout run evolves the
// existing map rather than reshuffling it.
function placeNodes(graph: BrainGraph) {
  const positioned = graph.filterNodes((_, a) => !a.parked && !a.placed);
  let radius = 10;
  if (positioned.length) {
    const cx = positioned.reduce((s, id) => s + graph.getNodeAttribute(id, "x"), 0) / positioned.length;
    const cy = positioned.reduce((s, id) => s + graph.getNodeAttribute(id, "y"), 0) / positioned.length;
    radius = Math.max(
      10,
      ...positioned.map((id) => Math.hypot(graph.getNodeAttribute(id, "x") - cx, graph.getNodeAttribute(id, "y") - cy)),
    );
  } else {
    radius = Math.max(10, Math.sqrt(graph.order) * 6);
  }

  // New embedded logs: centroid of already-positioned neighbours, plus jitter
  // so a log with a single neighbour doesn't land exactly on top of it.
  const anchored = new Set(positioned);
  graph.forEachNode((id, a) => {
    if (!a.placed) return;
    const neighbors = graph.neighbors(id).filter((n) => anchored.has(n));
    const jitter = () => (Math.random() - 0.5) * radius * 0.15;
    if (neighbors.length) {
      const x = neighbors.reduce((s, n) => s + graph.getNodeAttribute(n, "x"), 0) / neighbors.length;
      const y = neighbors.reduce((s, n) => s + graph.getNodeAttribute(n, "y"), 0) / neighbors.length;
      graph.mergeNodeAttributes(id, { x: x + jitter(), y: y + jitter() });
    } else {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      graph.mergeNodeAttributes(id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    anchored.add(id);
  });

  // Unembedded logs: evenly spaced on a ring outside the map; not saved.
  const parked = graph.filterNodes((_, a) => a.parked);
  parked.forEach((id, i) => {
    const angle = (i / parked.length) * Math.PI * 2;
    graph.mergeNodeAttributes(id, {
      x: Math.cos(angle) * radius * 1.35,
      y: Math.sin(angle) * radius * 1.35,
      fixed: true,
    });
  });
}

function colorCommunities(graph: BrainGraph) {
  if (graph.size === 0) return;
  louvain.assign(graph, { getEdgeWeight: "weight", nodeCommunityAttribute: "community" });

  // Rank communities by size so the biggest clusters get the first colours.
  const counts = new Map<number, number>();
  graph.forEachNode((_, a) => {
    if (a.community != null) counts.set(a.community, (counts.get(a.community) ?? 0) + 1);
  });
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const colorOf = new Map(ranked.map((c, i) => [c, PALETTE[i % PALETTE.length]]));

  graph.forEachNode((id, a) => {
    const alone = a.parked || graph.degree(id) === 0 || (counts.get(a.community!) ?? 0) < 2;
    graph.setNodeAttribute(id, "color", alone ? LONE_COLOR : colorOf.get(a.community!)!);
  });
}

// Positions worth persisting: embedded nodes only (parked ones are derived).
export function positionsToSave(graph: BrainGraph) {
  return graph
    .filterNodes((_, a) => !a.parked)
    .map((id) => ({
      id,
      x: Math.round(graph.getNodeAttribute(id, "x") * 100) / 100,
      y: Math.round(graph.getNodeAttribute(id, "y") * 100) / 100,
    }));
}
