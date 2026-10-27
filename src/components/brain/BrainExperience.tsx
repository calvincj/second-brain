"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  addTags,
  createCaptureToken,
  deleteLogInPlace,
  getLogDetail,
  restoreLog,
  retryEmbeddingWithNeighbors,
  revokeCaptureToken,
  saveLayoutVersion,
  savePositions,
  searchMap,
  signOut,
  type ActionResult,
} from "@/app/actions";
import { LogForm } from "@/components/LogForm";
import type { BrainHandle, RemovedThought } from "@/components/brain/Brain3D";
import { SearchResults } from "@/components/brain/SearchResults";
import { buildBrain, type BrainModel } from "@/lib/brain-model";
import { domainOf } from "@/lib/format";
import type { BrainSearchResult, LogWithImage } from "@/lib/queries";
import type { MapEdge, MapNode } from "@/lib/types";
import { useMediaQuery } from "@/lib/use-media-query";

// three.js needs WebGL and `window`, so the brain only renders in the browser.
const Brain3D = dynamic(() => import("@/components/brain/Brain3D"), {
  ssr: false,
  loading: () => <BrainLoading />,
});

function BrainLoading() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
      <span className="mr-3 h-3 w-3 animate-ping rounded-full bg-accent" />
      Waking up your brain…
    </div>
  );
}

type Sheet =
  | { kind: "node"; id: string }
  | { kind: "region"; id: number }
  | { kind: "capture"; prefill: string }
  | { kind: "shortcut" }
  | null;

type Props = { userId: string; nodes: MapNode[]; edges: MapEdge[]; layoutVersion: string | null; startCapture?: boolean };

type Toast = { text: string; id?: string; suggestions?: string[]; action?: { label: string; run: () => void } };

const RECENT_KEY = "brain:recent";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

// "A memory stirs": an embedded thought at least 2 days old, not looked at in
// a week, weighted toward older ones and bridges between regions.
function pickMemory(m: BrainModel, now: number): { id: string; ago: string } | null {
  const day = 864e5;
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const bridgeIds = new Set<string>();
  for (const l of m.links) {
    const s = typeof l.source === "string" ? l.source : l.source.id;
    const t = typeof l.target === "string" ? l.target : l.target.id;
    const a = byId.get(s);
    const b = byId.get(t);
    if (a?.region != null && b?.region != null && a.region !== b.region) bridgeIds.add(s).add(t);
  }
  const candidates = m.nodes
    .filter((n) => n.embedded && n.createdAt && now - Date.parse(n.createdAt) > 2 * day)
    .filter((n) => !n.lastViewedAt || now - Date.parse(n.lastViewedAt) > 7 * day)
    .map((n) => ({ n, w: Math.log(2 + (now - Date.parse(n.createdAt!)) / day) * (bridgeIds.has(n.id) ? 2 : 1) * Math.random() }));
  if (!candidates.length) return null;
  const pick = candidates.sort((a, b) => b.w - a.w)[0].n;
  const days = Math.round((now - Date.parse(pick.createdAt!)) / day);
  const ago = days < 7 ? `${days} days ago` : days < 60 ? `${Math.round(days / 7)} weeks ago` : `${Math.round(days / 30)} months ago`;
  return { id: pick.id, ago };
}

type Away = { ids: string[]; since: string; newRegions: string[]; milestone: number | null };

// "While you were away": what arrived since this device's last visit.
function whileAway(m: BrainModel, lastVisit: number, prevRegions: string[], prevCount: number): Away | null {
  const ids = m.nodes
    .filter((n) => n.createdAt && Date.parse(n.createdAt) > lastVisit)
    .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))
    .map((n) => n.id);
  if (!ids.length) return null;
  const known = new Set(prevRegions);
  const newRegions = m.regions.filter((r) => r.members.length && !known.has(r.name)).map((r) => r.name);
  const milestone = [25, 50, 100, 250, 500, 1000].find((x) => prevCount < x && m.nodes.length >= x) ?? null;
  const since = new Date(lastVisit).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return { ids, since, newRegions: prevRegions.length ? newRegions : [], milestone };
}

function rememberSearch(q: string) {
  try {
    const next = [q, ...readRecent().filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked; recents just won't persist.
  }
}

export function BrainExperience({ userId, nodes, edges, layoutVersion, startCapture = false }: Props) {
  const brain = useRef<BrainHandle>(null);
  // The renderer owns the live model after mount (it adds new thoughts itself),
  // so it gets a stable initial model; the UI keeps a copy refreshed on births.
  // Later prop changes (revalidation after a save) are deliberately ignored.
  const [initialModel] = useState(() => buildBrain(nodes, edges));
  const [model, setModel] = useState<BrainModel>(initialModel);

  const isMobile = useMediaQuery("(max-width: 767px), (pointer: coarse)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BrainSearchResult | null>(null);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [searching, startSearch] = useTransition();
  const [sheet, setSheet] = useState<Sheet>(startCapture ? { kind: "capture", prefill: "" } : null);
  const [trail, setTrail] = useState<string[]>([]);
  const [detail, setDetail] = useState<LogWithImage | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [meaningPending, setMeaningPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const meaningTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSemantic = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const sheetRef = useRef<Sheet>(null);
  const birthTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const measureRef = useRef<() => void>(() => {});
  const actedSinceSettle = useRef(false);
  const busyRef = useRef(false);
  const pendingTags = useRef<{ id: string; tags: string[]; timer?: ReturnType<typeof setTimeout> } | null>(null);
  // Server renders without the hint; the browser checks if it was dismissed.
  const hintStored = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return localStorage.getItem("brain:hint") === "1";
      } catch {
        return true;
      }
    },
    () => true,
  );
  const [hintDismissed, setHintDismissed] = useState(false);
  const hintSeen = hintStored || hintDismissed;
  function dismissHint() {
    if (hintSeen) return;
    setHintDismissed(true);
    try {
      localStorage.setItem("brain:hint", "1");
    } catch {
      // Storage blocked; the hint just shows again next time.
    }
  }
  const searchSeq = useRef(0);

  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model]);
  const neighborsOf = useCallback(
    (id: string) =>
      model.links
        .flatMap((l) => {
          const s = typeof l.source === "string" ? l.source : l.source.id;
          const t = typeof l.target === "string" ? l.target : l.target.id;
          return s === id ? [{ id: t, weight: l.weight }] : t === id ? [{ id: s, weight: l.weight }] : [];
        })
        .sort((a, b) => b.weight - a.weight),
    [model],
  );

  // Links from this region's thoughts into other regions, strongest first.
  function bridgesOf(regionId: number) {
    const members = new Set(model.regions[regionId]?.members ?? []);
    return model.links
      .map((l) => {
        const s = typeof l.source === "string" ? l.source : l.source.id;
        const t = typeof l.target === "string" ? l.target : l.target.id;
        const inside = members.has(s) ? s : members.has(t) ? t : null;
        const outside = inside === s ? t : s;
        if (!inside || members.has(outside) || nodeById.get(outside)?.region == null) return null;
        return { key: l.key, inside, outside, weight: l.weight };
      })
      .filter((b): b is NonNullable<typeof b> => !!b)
      .sort((a, b) => b.weight - a.weight);
  }

  function showToast(next: Toast | null, ms?: number) {
    clearTimeout(toastTimer.current);
    setToast(next);
    if (!next) return;
    // Linger longer when there's something to tap.
    const duration = ms ?? (next.suggestions?.length || next.action ? 8000 : 4500);
    toastTimer.current = setTimeout(() => setToast(null), duration);
  }

  // Tags tapped in quick succession are saved together: one re-embed, one
  // API call, instead of one per tap (Voyage free tier: 3/minute).
  function acceptTag(tag: string) {
    const current = toast;
    if (!current?.id) return;
    const id = current.id;
    const remaining = current.suggestions?.filter((t) => t !== tag) ?? [];
    showToast(remaining.length ? { ...current, suggestions: remaining } : { text: `Tagged #${tag}` }, remaining.length ? 8000 : 2500);
    const node = brain.current?.getModel().nodes.find((n) => n.id === id);
    if (node && !node.tags.includes(tag)) node.tags = [...node.tags, tag];
    if (brain.current) setModel({ ...brain.current.getModel() });

    const pending = pendingTags.current?.id === id ? pendingTags.current : { id, tags: [] as string[] };
    clearTimeout(pending.timer);
    pending.tags.push(tag);
    pending.timer = setTimeout(() => {
      addTags(pending.id, pending.tags);
      pendingTags.current = null;
    }, 3000);
    pendingTags.current = pending;
  }

  // Save batched tags right away (e.g. before an edit could overwrite them).
  function flushPendingTags() {
    const pending = pendingTags.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingTags.current = null;
    addTags(pending.id, pending.tags);
  }

  // --- Selecting a thought: it fires, the camera flies there, details load ---------
  function openNode(id: string, { fromTrail = false, auto = false } = {}) {
    if (!auto) clearTimeout(birthTimer.current);
    setMemory(null);
    const b = brain.current;
    if (!b) return;
    b.select(id);
    b.flyToNode(id);
    b.pulseFrom(id);
    setSheet({ kind: "node", id });
    setEditing(false);
    setTrail((t) => (fromTrail ? t : [...t.filter((x) => x !== id), id].slice(-5)));
    setDetail(null);
    selectedRef.current = id;
    // Only the latest selection's details may land (slow loads can't overwrite).
    getLogDetail(id).then((d) => {
      if (selectedRef.current === id) setDetail(d);
    });
  }

  function closeSheet() {
    setSheet(null);
    setEditing(false);
    selectedRef.current = null;
    setTrail([]);
    brain.current?.select(null);
  }

  // --- Search: live keyword preview while typing, full semantic on pause/Enter ----
  const runSearch = useCallback(
    (q: string, semantic: boolean, fly: boolean) => {
      const seq = ++searchSeq.current;
      if (semantic) {
        lastSemantic.current = q;
        setMeaningPending(true);
      }
      startSearch(async () => {
        let result: BrainSearchResult;
        try {
          result = await searchMap(q, semantic);
        } catch (err) {
          // A network blip must never take the whole brain down.
          console.error("Search failed", err);
          result = { query: q, hits: [], mode: "keyword", semanticUnavailable: true };
        }
        if (seq !== searchSeq.current) return; // a newer search started
        if (semantic) setMeaningPending(false);
        const known = result.hits.map((h) => h.id).filter((id) => nodeById.has(id));
        setResults(result);
        if (semantic && q.length >= 3) rememberSearch(q);
        if (known.length) {
          brain.current?.activate(known);
          // Don't yank the camera away from a thought you've opened.
          if (fly && !sheetRef.current) brain.current?.focusActivation();
        } else {
          brain.current?.clearActivation();
        }
      });
    },
    [nodeById],
  );

  function cancelTimers() {
    clearTimeout(liveTimer.current);
    clearTimeout(meaningTimer.current);
  }

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    if (q === lastSemantic.current) return; // already searched by meaning (Enter / recent)
    // Words match instantly as you type; meaning (which costs an API call)
    // waits until you've clearly stopped typing, or you press Enter.
    liveTimer.current = setTimeout(() => runSearch(q, false, false), 250);
    if (q.length >= 3) meaningTimer.current = setTimeout(() => runSearch(q, true, true), 2500);
    return cancelTimers;
  }, [query, runSearch]);

  function searchNow(q: string) {
    cancelTimers();
    setQuery(q);
    runSearch(q, true, true);
  }

  function onQueryChange(value: string) {
    clearTimeout(birthTimer.current);
    setMemory(null);
    setAway(null);
    setQuery(value);
    lastSemantic.current = null;
    setMeaningPending(false);
    if (value.trim().length < 2) {
      searchSeq.current++;
      setResults(null);
      brain.current?.clearActivation();
    }
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    searchNow(q);
    inputRef.current?.blur();
  }

  function clearSearch() {
    onQueryChange("");
    setQuery("");
  }

  // --- Regions -------------------------------------------------------------------------
  function openRegion(id: number) {
    clearTimeout(birthTimer.current);
    setMemory(null);
    setAway(null);
    const region = model.regions[id];
    if (!region) return;
    brain.current?.select(null);
    brain.current?.activate(region.members, { hops: 0 });
    brain.current?.flyToRegion(id);
    setSheet({ kind: "region", id });
  }

  // --- A new thought is born -------------------------------------------------------------
  function onSaved(result: Extract<ActionResult, { ok: true }>) {
    setMemory(null);
    setSheet(null);
    clearSearch();
    const linkedIds = brain.current?.addThought(result.node, result.neighbors) ?? [];
    if (brain.current) setModel(brain.current.getModel());
    const linked = linkedIds
      .map((id) => nodeById.get(id)?.caption)
      .filter((c): c is string => !!c)
      .slice(0, 2);
    // Suggest tags its real neighbours share (tags shape region names): a tag
    // used by at least two of them, or by the single closest one.
    const counts = new Map<string, number>();
    for (const id of linkedIds) {
      for (const t of nodeById.get(id)?.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const closest = new Set(linkedIds[0] ? (nodeById.get(linkedIds[0])?.tags ?? []) : []);
    const suggestions = [...counts.entries()]
      .filter(([t, c]) => !result.node.tags.includes(t) && (c >= 2 || closest.has(t)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);
    showToast({
      text: !result.embedded
        ? "Saved. It'll connect once it's processed."
        : linked.length
          ? `Connected to: ${linked.map((c) => (c.length > 38 ? `${c.slice(0, 37)}…` : c)).join(" · ")}`
          : "Saved. A new idea, unlike anything else in your brain yet.",
      id: result.node.id,
      suggestions,
    });
    birthTimer.current = setTimeout(() => openNode(result.node.id, { auto: true }), reducedMotion ? 50 : 2600);
  }

  // --- Edit and delete without leaving the brain ---------------------------------------
  function onEdited(result: Extract<ActionResult, { ok: true }>) {
    brain.current?.updateThought(result.node, result.neighbors);
    if (brain.current) setModel({ ...brain.current.getModel() });
    setEditing(false);
    getLogDetail(result.id).then((d) => {
      if (selectedRef.current === result.id) setDetail(d);
    });
    showToast({ text: "Updated. Its connections were refreshed." });
  }

  // Deleted at once (soft: purged after a week), so it sticks even if the app
  // is closed; Undo restores it in the brain and the database.
  function deleteThought(id: string) {
    if (pendingTags.current?.id === id) {
      clearTimeout(pendingTags.current.timer);
      pendingTags.current = null;
    }
    const removed: RemovedThought | null | undefined = brain.current?.removeThought(id);
    if (!removed) return;
    closeSheet();
    if (brain.current) setModel({ ...brain.current.getModel() });
    const saved = deleteLogInPlace(id);
    saved.then((ok) => {
      if (ok) return;
      // Keep the brain honest: the thought still exists, so bring it back.
      brain.current?.restoreThought(removed);
      if (brain.current) setModel({ ...brain.current.getModel() });
      showToast({ text: "Couldn't delete that. Check your connection." });
    });
    showToast(
      {
        text: "Thought deleted.",
        action: {
          label: "Undo",
          run: async () => {
            await saved;
            const ok = await restoreLog(id);
            if (!ok) {
              showToast({ text: "Couldn't undo that one." }, 3000);
              return;
            }
            brain.current?.restoreThought(removed);
            if (brain.current) setModel({ ...brain.current.getModel() });
            showToast({ text: "Restored." }, 2000);
          },
        },
      },
      6000,
    );
  }

  // --- "A memory stirs" ---------------------------------------------------------------
  // Once a day, an older thought you haven't looked at in a while wakes up.
  const [memory, setMemory] = useState<{ id: string; ago: string } | null>(null);
  const [away, setAway] = useState<Away | null>(null);
  // Bottom sheet on phones: dragged up to full height (per sheet), or down to dismiss.
  const [fullFor, setFullFor] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ y: number; t: number } | null>(null);
  const stirredRef = useRef(false);
  // After the brain has settled into view, and only if you aren't already
  // doing something (searching, reading, logging, touching the brain).
  const onBrainSettled = useCallback(() => {
    if (stirredRef.current || startCapture) return;
    stirredRef.current = true;
    actedSinceSettle.current = false;

    // Thoughts that failed to connect (e.g. the embedding quota was busy when
    // a Shortcut logged them) get another try, gently spaced.
    const stuck = (brain.current?.getModel() ?? initialModel).nodes.filter((n) => !n.embedded).slice(0, 2);
    stuck.forEach((n, i) => {
      setTimeout(async () => {
        const neighbors = await retryEmbeddingWithNeighbors(n.id).catch(() => null);
        if (!neighbors || !brain.current) return;
        brain.current.updateThought({ id: n.id, caption: n.caption, tags: n.tags, x: null, y: null, z: null, embedded: true }, neighbors);
        setModel({ ...brain.current.getModel() });
      }, 5000 + i * 25000);
    });

    setTimeout(() => {
      const m = brain.current?.getModel() ?? initialModel;
      let lastVisit = 0;
      let prevRegions: string[] = [];
      let prevCount = 0;
      try {
        lastVisit = Number(localStorage.getItem("brain:lastVisit") ?? 0);
        prevRegions = JSON.parse(localStorage.getItem("brain:regions") ?? "[]");
        prevCount = Number(localStorage.getItem("brain:count") ?? 0);
        localStorage.setItem("brain:lastVisit", String(Date.now()));
        localStorage.setItem("brain:regions", JSON.stringify(m.regions.filter((r) => r.members.length).map((r) => r.name)));
        localStorage.setItem("brain:count", String(m.nodes.length));
      } catch {
        return;
      }
      if (sheetRef.current || busyRef.current || actedSinceSettle.current) return;

      // New thoughts since last time take the stage instead of a memory.
      const summary = lastVisit ? whileAway(m, lastVisit, prevRegions, prevCount) : null;
      if (summary) {
        setAway(summary);
        brain.current?.replayBirths(summary.ids);
        return;
      }

      const today = new Date().toDateString();
      try {
        if (localStorage.getItem("brain:stirred") === today) return;
        localStorage.setItem("brain:stirred", today);
      } catch {
        return;
      }
      const pick = pickMemory(m, Date.now());
      if (!pick) return;
      setMemory(pick);
      brain.current?.stir(pick.id);
    }, 1200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Positions first; the layout version is recorded only once they're saved,
  // so a failed save means the brain simply re-settles next time.
  const onPositionsSettled = useCallback((version: string | null, positions: { id: string; x: number; y: number; z: number }[]) => {
    savePositions(positions)
      .then(() => (version ? saveLayoutVersion(version) : undefined))
      .catch((err) => console.error("Saving layout failed", err));
  }, []);

  const onBackground = useCallback(() => {
    setMenuOpen(false);
    setSheet((s) => (s?.kind === "capture" ? s : null));
    setTrail([]);
    brain.current?.select(null);
  }, []);

  const onSelect = useCallback((id: string) => openNode(id), []);

  useEffect(() => {
    sheetRef.current = sheet;
    // Searching or reading a toast counts as busy for "a memory stirs".
    busyRef.current = !!query.trim() || !!toast;
  }, [sheet, query, toast]);

  // Measure what the UI covers (chips on top; bar, results or sheet below; the
  // side panel on desktop) and centre the brain in the space that's left.
  // Labels avoid covered areas and framing fits around them.
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const measure = () => {
      // visualViewport shrinks when the iOS keyboard opens; innerHeight doesn't.
      const vv = window.visualViewport;
      const h = vv ? vv.height + vv.offsetTop : window.innerHeight;
      const w = window.innerWidth;
      const top = topRef.current?.getBoundingClientRect().bottom ?? 110;
      let bottomEdge = bottomRef.current ? bottomRef.current.offsetTop : h;
      let right = 0;
      const aside = asideRef.current;
      if (aside) {
        // offsetTop/Left ignore the slide-in animation's transform.
        if (isMobile) {
          if (sheet?.kind !== "capture") bottomEdge = Math.min(bottomEdge, aside.offsetTop);
        } else {
          right = w - aside.offsetLeft;
        }
      }
      bottomEdge = Math.min(bottomEdge, h);
      brain.current?.setOcclusion(top, Math.max(0, h - bottomEdge), right);
      const visibleCentre = (top + bottomEdge) / 2;
      brain.current?.setViewShift(right / (2 * w), Math.min(0.35, Math.max(-0.35, (h / 2 - visibleCentre) / h)));
    };
    measureRef.current = measure;
    measure();
    const observer = new ResizeObserver(measure);
    [topRef.current, bottomRef.current, asideRef.current].forEach((el) => el && observer.observe(el));
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [isMobile, sheet, results, query, focused, toast]);

  const sheetKey = sheet ? (sheet.kind === "node" ? `node:${sheet.id}` : sheet.kind === "region" ? `region:${sheet.id}` : sheet.kind) : null;
  const sheetFull = !!sheetKey && fullFor === sheetKey;

  function onHandleDown(e: React.PointerEvent) {
    if (!isMobile) return;
    drag.current = { y: e.clientY, t: e.timeStamp };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onHandleMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setDragY(e.clientY - drag.current.y);
  }
  function onHandleUp(e: React.PointerEvent) {
    if (!drag.current) return;
    const dy = e.clientY - drag.current.y;
    const velocity = dy / Math.max(1, e.timeStamp - drag.current.t);
    drag.current = null;
    setDragY(0);
    if (dy > 90 || velocity > 0.6) {
      if (sheetFull) setFullFor(null);
      else if (sheet?.kind === "capture" || sheet?.kind === "shortcut") setSheet(null);
      else closeSheet();
    } else if (dy < -50) {
      setFullFor(sheetKey);
    }
  }

  const thoughtCount = model.nodes.length;
  const selectedNode = sheet?.kind === "node" ? nodeById.get(sheet.id) : undefined;
  const region = sheet?.kind === "region" ? model.regions[sheet.id] : undefined;

  return (
    <div
      className="brain-scope fixed inset-0 overflow-hidden"
      onPointerDown={() => {
        actedSinceSettle.current = true;
        dismissHint();
      }}
      onKeyDown={() => (actedSinceSettle.current = true)}
    >
      {thoughtCount > 0 && (
        <Brain3D
          ref={brain}
          model={initialModel}
          layoutVersion={layoutVersion}
          onReady={() => measureRef.current()}
          onSettled={onBrainSettled}
          isMobile={isMobile}
          reducedMotion={reducedMotion}
          onSelect={onSelect}
          onBackground={onBackground}
          onPositionsSettled={onPositionsSettled}
        />
      )}

      {/* Screen readers / keyboard: the 3D brain as a plain list. */}
      <nav aria-label="Thoughts by region" className="sr-only">
        {model.regions.map((r) => (
          <section key={r.id}>
            <h2>{r.name}</h2>
            <ul>
              {r.members.map((id) => (
                <li key={id}>
                  <button onClick={() => openNode(id)}>{nodeById.get(id)?.caption}</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {model.nodes.some((n) => n.region == null) && (
          <section>
            <h2>Other thoughts</h2>
            <ul>
              {model.nodes
                .filter((n) => n.region == null)
                .map((n) => (
                  <li key={n.id}>
                    <button onClick={() => openNode(n.id)}>{n.caption}</button>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </nav>

      {thoughtCount === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
          <span className="relative flex h-6 w-6">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-6 w-6 rounded-full bg-accent shadow-[0_0_30px_var(--accent)]" />
          </span>
          <p className="max-w-xs text-muted">Your brain is empty. Log the last interesting thing you learned, and watch it light up.</p>
        </div>
      )}

      {/* Top: menu, stats, regions */}
      <div
        ref={topRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 space-y-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="pointer-events-auto relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Menu"
              aria-expanded={menuOpen}
              className="flex h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm font-semibold backdrop-blur"
            >
              <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]" />
              2nd Brain
            </button>
            {menuOpen && (
              <div className="brain-fade-in absolute left-0 top-12 w-56 overflow-hidden rounded-2xl border border-border bg-surface py-1 text-sm backdrop-blur">
                {thoughtCount > 0 && (
                  <p className="border-b border-border px-4 py-3 text-xs text-muted">
                    <b className="text-text">{thoughtCount}</b> thoughts · <b className="text-text">{model.regions.length}</b> regions
                  </p>
                )}
                <Link href="/list" className="block px-4 py-3 hover:bg-surface-2">
                  List view
                </Link>
                <Link href="/capture" className="block px-4 py-3 hover:bg-surface-2">
                  Quick capture page
                </Link>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setSheet({ kind: "shortcut" });
                  }}
                  className="block w-full px-4 py-3 text-left hover:bg-surface-2"
                >
                  iPhone Shortcut…
                </button>
                <a href="/api/export" className="block px-4 py-3 hover:bg-surface-2">
                  Export backup
                </a>
                <form action={signOut}>
                  <button className="block w-full px-4 py-3 text-left text-muted hover:bg-surface-2">Sign out</button>
                </form>
              </div>
            )}
          </div>
        </div>

        {model.regions.length > 0 && (
          <nav aria-label="Regions" className="pointer-events-auto -mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]">
            {model.regions.filter((r) => r.members.length > 0).map((r) => (
              <button
                key={r.id}
                onClick={() => openRegion(r.id)}
                className={`flex h-9 shrink-0 items-center gap-2 rounded-full border bg-surface px-3 text-sm backdrop-blur ${
                  region?.id === r.id ? "border-text" : "border-border"
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color, boxShadow: `0 0 10px ${r.color}` }} />
                {r.name}
                <span className="text-muted">{r.members.length}</span>
              </button>
            ))}
          </nav>
        )}

        {away && !sheet && (
          <div className="brain-fade-in pointer-events-auto mx-auto max-w-md rounded-2xl border border-accent/40 bg-surface p-4 backdrop-blur-xl">
            <div className="flex items-start gap-3">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-accent shadow-[0_0_12px_var(--accent)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wide text-muted">While you were away · since {away.since}</p>
                <p className="mt-1 leading-snug">
                  <b>+{away.ids.length}</b> new thought{away.ids.length === 1 ? "" : "s"}
                  {away.newRegions.length > 0 && <> · new region{away.newRegions.length === 1 ? "" : "s"}: {away.newRegions.join(", ")}</>}
                  {away.milestone && <> · {away.milestone} thoughts ✦</>}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {away.ids.slice(0, 3).map((id) => (
                    <button
                      key={id}
                      onClick={() => {
                        setAway(null);
                        openNode(id);
                      }}
                      className="max-w-full truncate rounded-full bg-accent-soft px-3 py-1.5 text-xs text-accent"
                    >
                      {nodeById.get(id)?.caption}
                    </button>
                  ))}
                  <button onClick={() => setAway(null)} className="rounded-full px-3 py-1.5 text-xs text-muted">
                    Nice
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {toast && (
          <div
            role="status"
            className="brain-fade-in pointer-events-auto mx-auto max-w-md rounded-2xl border border-accent/40 bg-surface px-4 py-3 text-sm backdrop-blur"
          >
            ✦ {toast.text}
            {toast.action && (
              <button onClick={toast.action.run} className="ml-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
                {toast.action.label}
              </button>
            )}
            {toast.suggestions && toast.suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted">Add a tag?</span>
                {toast.suggestions.map((t) => (
                  <button key={t} onClick={() => acceptTag(t)} className="rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent">
                    + {t}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {memory && !sheet && nodeById.get(memory.id) && (
          <div className="brain-fade-in pointer-events-auto mx-auto max-w-md rounded-2xl border border-border bg-surface p-4 backdrop-blur-xl">
            <div className="flex items-start gap-3">
              <span
                className="mt-1 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full"
                style={{ background: nodeById.get(memory.id)!.color, boxShadow: `0 0 12px ${nodeById.get(memory.id)!.color}` }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wide text-muted">
                  A memory stirs
                  {nodeById.get(memory.id)!.region != null && <> · {model.regions[nodeById.get(memory.id)!.region!]?.name}</>} ·{" "}
                  {memory.ago}
                </p>
                <p className="mt-1 leading-snug">{nodeById.get(memory.id)!.caption}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      const id = memory.id;
                      setMemory(null);
                      brain.current?.clearActivation();
                      openNode(id);
                    }}
                    className="rounded-full bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => {
                      setMemory(null);
                      brain.current?.clearActivation();
                    }}
                    className="rounded-full px-3 py-1.5 text-xs text-muted"
                  >
                    Not now
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {thoughtCount > 0 && thoughtCount < 8 && !sheet && !toast && (
          <p className="pointer-events-auto mx-auto w-fit rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted backdrop-blur">
            Log a few more thoughts and regions will start to form.
          </p>
        )}
      </div>

      {!hintSeen && thoughtCount > 0 && !sheet && !query && (
        <p className="brain-fade-in pointer-events-none absolute inset-x-0 bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] z-10 mx-auto w-fit rounded-full border border-border bg-surface px-4 py-2 text-xs text-muted backdrop-blur">
          {isMobile ? "Drag to spin · pinch to zoom · tap a neuron" : "Drag to spin · scroll to zoom · click a neuron"}
        </p>
      )}


      {/* Bottom: search / add */}
      {!(isMobile && sheet) && (
        <div ref={bottomRef} className="absolute inset-x-0 bottom-0 z-10 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {results && query.trim().length >= 2 && !sheet && (
            <SearchResults
              results={results}
              model={model}
              nodeById={nodeById}
              searchingMeaning={meaningPending && results.mode === "keyword"}
              onOpen={(id) => openNode(id)}
              onCapture={() => setSheet({ kind: "capture", prefill: query.trim() })}
            />
          )}
          {focused && !query && recent.length > 0 && (
            <div className="brain-fade-in mx-auto mb-2 flex max-w-xl items-center gap-2 overflow-x-auto [scrollbar-width:none]">
              <span className="shrink-0 text-xs text-muted">Recent</span>
              {recent.map((r) => (
                <button
                  key={r}
                  // Fires before the input blurs, so the tap isn't lost.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    searchNow(r);
                  }}
                  className="h-9 shrink-0 rounded-full border border-border bg-surface px-3 text-sm backdrop-blur"
                >
                  {r}
                </button>
              ))}
            </div>
          )}
          <form onSubmit={submitSearch} className="mx-auto flex max-w-xl items-center gap-2">
            <div className="relative flex-1">
              <input
                ref={inputRef}
                type="search"
                enterKeyHint="search"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onFocus={() => {
                  setFocused(true);
                  setRecent(readRecent());
                }}
                onBlur={() => setFocused(false)}
                placeholder={thoughtCount ? "Search your brain…" : "Type a thought, then tap ＋"}
                aria-label="Search your brain"
                className="h-12 w-full rounded-full border border-border bg-surface pl-5 pr-16 text-text [&::-webkit-search-cancel-button]:appearance-none shadow-[0_0_40px_rgba(94,230,208,0.08)] outline-none backdrop-blur placeholder:text-muted focus:border-accent"
              />
              {searching && (
                <span className="absolute right-11 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-muted border-t-transparent" />
              )}
              {query && (
                <button type="button" onClick={clearSearch} aria-label="Clear search" className="absolute right-1 top-1/2 h-10 w-10 -translate-y-1/2 text-muted">
                  ×
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setMemory(null);
                setAway(null);
                setSheet({ kind: "capture", prefill: query.trim() });
              }}
              aria-label="Log a new thought"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-2xl font-light text-on-accent shadow-[0_0_24px_rgba(94,230,208,0.55)]"
            >
              ＋
            </button>
          </form>
        </div>
      )}

      {/* Sheets: bottom on mobile, right panel on desktop */}
      {sheet && (
        <aside
          ref={asideRef}
          key={sheet.kind === "node" ? sheet.id : sheet.kind}
          style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
          className={`brain-sheet-in absolute inset-x-0 bottom-0 z-30 ${sheetFull ? "max-h-[90dvh]" : "max-h-[62dvh]"} overflow-y-auto rounded-t-3xl transition-[max-height] duration-300 border-t border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-xl md:inset-x-auto md:bottom-24 md:right-4 md:top-28 md:max-h-none md:w-96 md:rounded-3xl md:border`}
        >
          {/* Drag handle: up to expand, down to dismiss. */}
          <div
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            className="-mx-4 -mt-4 mb-1 flex h-8 touch-none items-center justify-center md:hidden"
            aria-hidden
          >
            <span className="h-1 w-10 rounded-full bg-border" />
          </div>

          {sheet.kind === "shortcut" && <ShortcutSetup onClose={() => setSheet(null)} />}

          {sheet.kind === "capture" && (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">New thought</h2>
                <button onClick={() => setSheet(null)} aria-label="Close" className="-mr-2 h-11 w-11 text-xl text-muted">
                  ×
                </button>
              </div>
              <LogForm userId={userId} prefill={sheet.prefill} autoFocus onSaved={onSaved} />
            </div>
          )}

          {sheet.kind === "region" && region && (
            <div>
              <div className="mb-3 flex items-start gap-3">
                <span className="mt-1.5 h-3 w-3 rounded-full" style={{ background: region.color, boxShadow: `0 0 12px ${region.color}` }} />
                <div className="flex-1">
                  <h2 className="text-lg font-semibold">{region.name}</h2>
                  <p className="text-xs text-muted">{region.members.length} thoughts in this region</p>
                </div>
                <button
                  onClick={() => {
                    closeSheet();
                    brain.current?.clearActivation();
                    brain.current?.fitAll();
                  }}
                  aria-label="Close"
                  className="-mr-2 -mt-2 h-11 w-11 text-xl text-muted"
                >
                  ×
                </button>
              </div>
              {bridgesOf(region.id).length > 0 && (
                <div className="mb-3 rounded-2xl border border-border p-3">
                  <p className="mb-1 text-xs uppercase tracking-wide text-muted">Bridges to other regions</p>
                  {bridgesOf(region.id).slice(0, 3).map((b) => (
                    <button key={b.key} onClick={() => openNode(b.outside)} className="flex w-full items-start gap-2 py-1.5 text-left text-sm leading-snug">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: nodeById.get(b.outside)?.color }} />
                      <span>
                        <span className="text-muted">{nodeById.get(b.inside)?.caption.slice(0, 40)}… ↔ </span>
                        {nodeById.get(b.outside)?.caption}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <ul>
                {region.members.map((id) => (
                  <li key={id}>
                    <button onClick={() => openNode(id)} className="w-full rounded-xl px-2 py-3 text-left text-sm leading-snug hover:bg-surface-2">
                      {nodeById.get(id)?.caption}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sheet.kind === "node" && selectedNode && editing && detail?.id === selectedNode.id && (
            <div>
              <h2 className="mb-3 font-semibold">Edit thought</h2>
              <LogForm
                userId={userId}
                logId={selectedNode.id}
                initial={{
                  caption: detail.caption,
                  // The brain's copy includes tags accepted moments ago.
                  tags: selectedNode.tags,
                  sourceUrl: detail.source_url ?? "",
                  imagePath: detail.image_path,
                  imageUrl: detail.imageUrl,
                }}
                onDone={() => setEditing(false)}
                onSaved={onEdited}
              />
            </div>
          )}

          {sheet.kind === "node" && selectedNode && !editing && (
            <div>
              {trail.length > 1 && (
                <div className="-mx-1 mb-3 flex items-center gap-1 overflow-x-auto text-xs text-muted [scrollbar-width:none]">
                  {trail.slice(0, -1).map((id) => (
                    <button
                      key={id}
                      onClick={() => {
                        setTrail((t) => t.slice(0, t.indexOf(id) + 1));
                        openNode(id, { fromTrail: true });
                      }}
                      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1"
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: nodeById.get(id)?.color }} />
                      <span className="max-w-[7rem] truncate">{nodeById.get(id)?.caption}</span>
                    </button>
                  ))}
                  <span className="shrink-0">→</span>
                </div>
              )}

              <div className="flex items-start gap-3">
                <span
                  className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
                  style={{ background: selectedNode.color, boxShadow: `0 0 12px ${selectedNode.color}` }}
                />
                <div className="min-w-0 flex-1">
                  {selectedNode.region != null && (
                    <button onClick={() => openRegion(selectedNode.region!)} className="mb-1 text-xs uppercase tracking-wide" style={{ color: selectedNode.color }}>
                      {model.regions[selectedNode.region]?.name}
                    </button>
                  )}
                  <p className="whitespace-pre-wrap break-words text-lg leading-snug">{selectedNode.caption}</p>
                </div>
                <button onClick={closeSheet} aria-label="Close" className="-mr-2 -mt-2 h-11 w-11 shrink-0 text-xl text-muted">
                  ×
                </button>
              </div>

              {selectedNode.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {selectedNode.tags.map((t) => (
                    <span key={t} className="rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {detail?.id === selectedNode.id && (
                <>
                  {detail.source_url && (
                    <a href={detail.source_url} target="_blank" rel="noopener noreferrer" className="mt-3 block truncate text-sm text-accent">
                      ↗ {detail.source_title ?? domainOf(detail.source_url)}
                    </a>
                  )}
                  {detail.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={detail.imageUrl} alt="" className="mt-3 max-h-48 rounded-2xl border border-border" />
                  )}
                </>
              )}

              {!selectedNode.embedded && <p className="mt-3 text-xs text-muted">Not connected yet, so it floats at the edge for now.</p>}

              {neighborsOf(selectedNode.id).length > 0 && (
                <>
                  <h3 className="mt-5 text-xs uppercase tracking-wide text-muted">Connected thoughts</h3>
                  <ul className="mt-1">
                    {neighborsOf(selectedNode.id).map((n) => {
                      const node = nodeById.get(n.id);
                      if (!node) return null;
                      return (
                        <li key={n.id}>
                          <button onClick={() => openNode(n.id)} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left text-sm hover:bg-surface-2">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: node.color }} />
                            <span className="flex-1 leading-snug">{node.caption}</span>
                            <span className="text-muted">→</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={() => {
                    flushPendingTags();
                    setEditing(true);
                  }}
                  disabled={detail?.id !== selectedNode.id}
                  className="h-11 rounded-full border border-border px-4 text-sm disabled:opacity-50"
                >
                  Edit
                </button>
                <button onClick={() => deleteThought(selectedNode.id)} className="h-11 rounded-full px-4 text-sm text-danger">
                  Delete
                </button>
                <Link href={`/log/${selectedNode.id}`} className="ml-auto inline-flex h-11 items-center text-sm text-muted">
                  Full page →
                </Link>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

// Set up "Log a thought" from an iPhone Shortcut / the Share Sheet / Siri.
function ShortcutSetup({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [pending, startTransition] = useTransition();
  const endpoint = typeof window !== "undefined" ? `${window.location.origin}/api/capture` : "/api/capture";

  return (
    <div className="text-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Log from anywhere on your iPhone</h2>
        <button onClick={onClose} aria-label="Close" className="-mr-2 h-11 w-11 text-xl text-muted">
          ×
        </button>
      </div>
      <p className="text-muted">
        A Shortcut can send a thought straight to your brain, from the Share Sheet, the Action button or Siri, without opening the app.
      </p>
      {!token ? (
        <button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const t = await createCaptureToken();
              if (t) setToken(t);
              else setError(true);
            })
          }
          className="mt-4 h-11 rounded-full bg-accent px-5 font-medium text-on-accent disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create my personal token"}
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted">Shown once. Creating a new one turns this one off.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">{token}</code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(token).then(() => setCopied(true));
              }}
              className="h-9 shrink-0 rounded-full bg-accent-soft px-3 text-xs text-accent"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-muted">
            <li>Shortcuts app → + → add <b className="text-text">Get Contents of URL</b>.</li>
            <li>
              URL: <code className="text-text">{endpoint}</code>, Method <b className="text-text">POST</b>.
            </li>
            <li>
              Header <b className="text-text">Authorization</b> = <code className="text-text">Bearer &lt;token&gt;</code>.
            </li>
            <li>
              Request Body <b className="text-text">JSON</b>: key <code className="text-text">text</code> = Shortcut Input (or Ask for Input).
              Optional: <code className="text-text">tags</code>, <code className="text-text">url</code>.
            </li>
            <li>
              In the Shortcut&rsquo;s settings, turn on <b className="text-text">Show in Share Sheet</b>.
            </li>
          </ol>
        </div>
      )}
      {error && <p className="mt-3 text-danger">Couldn&rsquo;t create a token. Has migration 0008 been run?</p>}
      <button
        onClick={() =>
          startTransition(async () => {
            if (await revokeCaptureToken()) {
              setToken(null);
              setRevoked(true);
            }
          })
        }
        className="mt-5 block text-xs text-muted underline-offset-2 hover:underline"
      >
        {revoked ? "Token revoked. Shortcuts using it will stop working." : "Revoke my token"}
      </button>
    </div>
  );
}
