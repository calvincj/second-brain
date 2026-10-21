"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import { savePositions, searchMap } from "@/app/actions";
import { buildGraph, positionsToSave, type BrainGraph, type EdgeAttrs, type NodeAttrs } from "@/lib/graph";
import type { MapEdge, MapNode } from "@/lib/types";

const COLD_START = 50;

type Props = { nodes: MapNode[]; edges: MapEdge[] };

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default function BrainMap({ nodes, edges }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);
  const graph = useMemo<BrainGraph>(() => buildGraph(nodes, edges), [nodes, edges]);

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hits, setHits] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();

  // --- Sigma instance -------------------------------------------------------
  useEffect(() => {
    if (!container.current) return;
    const sigma = new Sigma<NodeAttrs, EdgeAttrs>(graph, container.current, {
      renderEdgeLabels: false,
      labelColor: { color: cssVar("--text") || "#16161d" },
      labelFont: "var(--font-geist-sans), system-ui, sans-serif",
      labelSize: 12,
      labelRenderedSizeThreshold: 7,
      labelDensity: 0.6,
      zIndex: true,
      minCameraRatio: 0.03,
      maxCameraRatio: 4,
      defaultEdgeColor: cssVar("--border"),
    });
    sigmaRef.current = sigma;

    sigma.on("enterNode", ({ node }) => setHovered(node));
    sigma.on("leaveNode", () => setHovered(null));
    sigma.on("clickNode", ({ node }) => setSelected(node));
    sigma.on("clickStage", () => {
      setSelected(null);
      setHits([]);
      setSearched(null);
    });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [graph]);

  // --- Layout ---------------------------------------------------------------
  const runLayout = useCallback(
    (durationMs: number) => {
      if (layoutRef.current?.isRunning() || graph.order < 2) return;
      const settings = {
        ...forceAtlas2.inferSettings(graph),
        gravity: 0.6,
        scalingRatio: 8,
        edgeWeightInfluence: 1.5,
        barnesHutOptimize: graph.order > 400,
      };
      const layout = new FA2Layout(graph, { settings, getEdgeWeight: "weight" });
      layoutRef.current = layout;
      setArranging(true);
      layout.start();
      setTimeout(async () => {
        layout.kill();
        layoutRef.current = null;
        setArranging(false);
        graph.forEachNode((id) => graph.setNodeAttribute(id, "placed", false));
        try {
          await savePositions(positionsToSave(graph));
          setSaveError(null);
        } catch (err) {
          setSaveError(err instanceof Error ? err.message : "Couldn't save layout");
        }
      }, durationMs);
    },
    [graph],
  );

  // Auto re-layout when new logs need a home; the first layout runs longer.
  useEffect(() => {
    const unplaced = graph.filterNodes((_, a) => a.placed).length;
    if (unplaced === 0) return;
    const firstRun = unplaced === graph.filterNodes((_, a) => !a.parked).length;
    runLayout(firstRun ? Math.min(2500 + graph.order * 4, 8000) : 1500);
    return () => {
      layoutRef.current?.kill();
      layoutRef.current = null;
    };
  }, [graph, runLayout]);

  // --- Highlighting -----------------------------------------------------------
  const focus = selected ?? hovered;
  const focusSet = useMemo(() => {
    if (!focus || !graph.hasNode(focus)) return null;
    return new Set([focus, ...graph.neighbors(focus)]);
  }, [focus, graph]);
  const hitSet = useMemo(() => new Set(hits), [hits]);

  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const dim = cssVar("--border");
    const accent = cssVar("--accent");

    sigma.setSetting("nodeReducer", (node, data) => {
      const res: Partial<typeof data> & { highlighted?: boolean; zIndex?: number } = { ...data };
      if (hitSet.has(node)) {
        res.size = data.size * 1.7;
        res.highlighted = true;
        res.zIndex = 2;
      }
      if (focusSet) {
        if (focusSet.has(node)) {
          res.zIndex = 3;
          if (node === focus) res.highlighted = true;
        } else if (!hitSet.has(node)) {
          res.color = dim;
          res.label = "";
          res.zIndex = 0;
        }
      } else if (hitSet.size && !hitSet.has(node)) {
        res.color = dim;
        res.label = "";
      }
      return res;
    });

    // Edges stay hidden until a node is focused: the "synapses" light up.
    sigma.setSetting("edgeReducer", (edge, data) => {
      const [s, t] = graph.extremities(edge);
      if (focus && (s === focus || t === focus)) {
        return { ...data, hidden: false, color: accent, size: 0.5 + data.weight * 2.5 };
      }
      return { ...data, hidden: true };
    });
  }, [focus, focusSet, hitSet, graph]);

  // --- Camera -------------------------------------------------------------------
  // Centre on a node, zoomed just enough to keep its neighbourhood in view.
  const flyTo = useCallback((id: string) => {
    const sigma = sigmaRef.current;
    if (!sigma || !sigma.getGraph().hasNode(id)) return;
    const pos = sigma.getNodeDisplayData(id);
    if (!pos) return;
    let reach = 0;
    for (const n of sigma.getGraph().neighbors(id)) {
      const p = sigma.getNodeDisplayData(n);
      if (p) reach = Math.max(reach, Math.hypot(p.x - pos.x, p.y - pos.y));
    }
    const ratio = Math.min(1, Math.max(0.08, reach ? reach * 2.6 : 0.3));
    sigma.getCamera().animate({ x: pos.x, y: pos.y, ratio }, { duration: 700 });
  }, []);

  function select(id: string) {
    setSelected(id);
    flyTo(id);
  }

  function zoom(factor: number) {
    const camera = sigmaRef.current?.getCamera();
    if (!camera) return;
    if (factor === 0) camera.animatedReset({ duration: 500 });
    else camera.animate({ ratio: camera.ratio * factor }, { duration: 250 });
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    startSearch(async () => {
      const ids = (await searchMap(q)).filter((id) => graph.hasNode(id));
      setHits(ids);
      setSearched(q);
      if (ids.length) select(ids[0]);
      else setSelected(null);
    });
  }

  const embeddedCount = nodes.filter((n) => n.embedded).length;
  const selectedAttrs = selected && graph.hasNode(selected) ? graph.getNodeAttributes(selected) : null;
  const selectedNeighbors = selected && graph.hasNode(selected)
    ? graph
        .neighbors(selected)
        .map((n) => ({ id: n, label: graph.getNodeAttribute(n, "caption"), weight: graph.getEdgeAttribute(selected, n, "weight") }))
        .sort((a, b) => b.weight - a.weight)
    : [];

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-bg">
      <div ref={container} className="absolute inset-0" />

      {/* Top bar: back + search */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto mx-auto flex w-full max-w-xl items-center gap-2">
          <Link
            href="/"
            aria-label="Back to list"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-muted"
          >
            ←
          </Link>
          <form onSubmit={search} className="relative flex-1">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the map…"
              className="h-11 w-full rounded-xl border border-border bg-surface px-4 pr-10 shadow-sm outline-none focus:border-accent"
            />
            {searching && (
              <span className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-muted border-t-transparent" />
            )}
          </form>
        </div>

        {searched && (
          <div className="pointer-events-auto mx-auto w-full max-w-xl rounded-xl border border-border bg-surface/95 p-2 shadow-sm backdrop-blur">
            <div className="flex items-center justify-between px-2 py-1 text-xs text-muted">
              <span>
                {hits.length} match{hits.length === 1 ? "" : "es"} for &ldquo;{searched}&rdquo;
              </span>
              <button
                onClick={() => {
                  setHits([]);
                  setSearched(null);
                  setSelected(null);
                }}
                className="px-2 py-1"
              >
                Clear
              </button>
            </div>
            <ul className="max-h-36 overflow-y-auto">
              {hits.slice(0, 8).map((id) => (
                <li key={id}>
                  <button
                    onClick={() => select(id)}
                    className={`w-full truncate rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2 ${id === selected ? "text-accent" : ""}`}
                  >
                    {graph.getNodeAttribute(id, "caption")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!searched && nodes.length > 0 && nodes.length < COLD_START && (
          <p className="pointer-events-auto mx-auto rounded-full border border-border bg-surface/90 px-3 py-1 text-xs text-muted backdrop-blur">
            {nodes.length} logs. Clusters get interesting around {COLD_START}.
          </p>
        )}
      </div>

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
          No logs yet. Add a few from the list view and they&rsquo;ll appear here.
        </div>
      )}

      {/* Controls */}
      <div className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-3 flex flex-col gap-2">
        {[
          { label: "+", title: "Zoom in", f: 0.6 },
          { label: "−", title: "Zoom out", f: 1.6 },
          { label: "⤢", title: "Fit all", f: 0 },
        ].map((b) => (
          <button
            key={b.title}
            title={b.title}
            aria-label={b.title}
            onClick={() => zoom(b.f)}
            className="h-11 w-11 rounded-xl border border-border bg-surface text-lg shadow-sm"
          >
            {b.label}
          </button>
        ))}
        <button
          title="Re-arrange"
          aria-label="Re-arrange layout"
          disabled={arranging || embeddedCount < 2}
          onClick={() => runLayout(2500)}
          className="h-11 w-11 rounded-xl border border-border bg-surface text-lg shadow-sm disabled:opacity-50"
        >
          ↻
        </button>
      </div>

      {(arranging || saveError) && (
        <p className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-3 rounded-full border border-border bg-surface/90 px-3 py-1 text-xs text-muted backdrop-blur">
          {arranging ? "Arranging…" : `Layout not saved: ${saveError}`}
        </p>
      )}

      {/* Detail: bottom sheet on mobile, side panel on desktop */}
      {selectedAttrs && selected && (
        <aside className="absolute inset-x-0 bottom-0 max-h-[55dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-20 sm:max-h-[calc(100dvh-6rem)] sm:w-80 sm:rounded-2xl sm:border">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border sm:hidden" />
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ background: selectedAttrs.color }} />
            <p className="flex-1 whitespace-pre-wrap break-words leading-snug">{selectedAttrs.caption}</p>
            <button onClick={() => setSelected(null)} aria-label="Close" className="-mr-2 -mt-2 h-11 w-11 text-muted">
              ×
            </button>
          </div>
          {selectedAttrs.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selectedAttrs.tags.map((t) => (
                <span key={t} className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
                  {t}
                </span>
              ))}
            </div>
          )}
          {selectedAttrs.parked && <p className="mt-2 text-xs text-muted">Not linked yet, so it&rsquo;s parked at the edge.</p>}
          <Link href={`/log/${selected}`} className="mt-3 inline-flex h-11 items-center text-sm text-accent">
            Open log →
          </Link>
          {selectedNeighbors.length > 0 && (
            <>
              <h3 className="mt-2 text-xs uppercase tracking-wide text-muted">Connected</h3>
              <ul className="mt-1">
                {selectedNeighbors.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => select(n.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-sm hover:bg-surface-2"
                    >
                      <span className="flex-1 truncate">{n.label}</span>
                      <span className="text-xs text-muted">{Math.round(n.weight * 100)}%</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
