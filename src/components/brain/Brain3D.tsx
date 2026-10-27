"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
// @ts-expect-error -- d3-force-3d ships no types
import { forceCollide } from "d3-force-3d";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  defaultK,
  LONE_COLOR,
  spreadActivation,
  type Activation,
  type BrainLink,
  type BrainModel,
  type BrainNode,
} from "@/lib/brain-model";
import type { MapEdge, MapNode } from "@/lib/types";

export type BrainHandle = {
  activate: (seedIds: string[], options?: { hops?: number }) => Map<string, Activation>;
  clearActivation: () => void;
  flyToNode: (id: string) => void;
  focusActivation: () => void;
  flyToRegion: (regionId: number) => void;
  fitAll: () => void;
  select: (id: string | null) => void;
  // Returns the ids it actually connected to.
  addThought: (node: MapNode, neighbors: MapEdge[]) => string[];
  updateThought: (node: MapNode, neighbors: MapEdge[]) => void;
  removeThought: (id: string) => RemovedThought | null;
  restoreThought: (removed: RemovedThought) => void;
  pulseFrom: (id: string) => void;
  getModel: () => BrainModel;
  // Shift the picture by these fractions of width/height (to centre it in the
  // space the UI leaves free).
  setViewShift: (x: number, y: number) => void;
  // Screen areas (px) covered by UI: labels avoid them, framing fits around them.
  setOcclusion: (top: number, bottom: number, right: number) => void;
  // "A memory stirs": drift to an old thought and let it glow.
  stir: (id: string) => void;
  // "While you were away": thoughts that arrived since your last visit fire
  // one after another.
  replayBirths: (ids: string[]) => void;
};

export type RemovedThought = { node: BrainNode; links: BrainLink[]; region: number | null };

type Props = {
  model: BrainModel;
  // Layout rules the saved positions were made with (null = unknown).
  layoutVersion: string | null;
  onReady?: () => void;
  // The first layout has settled (or there was nothing to settle).
  onSettled?: () => void;
  isMobile: boolean;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  onBackground: () => void;
  // version: set when these positions follow new layout rules (save it after).
  onPositionsSettled: (version: string | null, positions: { id: string; x: number; y: number; z: number }[]) => void;
  ref?: Ref<BrainHandle>;
};

type Visual = {
  group: THREE.Group;
  core: THREE.Mesh;
  coreMaterial: THREE.MeshBasicMaterial;
  glow: THREE.Sprite;
  baseScale: number;
  phase: number;
  speed: number;
  level: number; // eased activation
  target: number; // activation target
  flash: number; // short-lived burst from an arriving pulse
  label: SpriteText | null;
  labelBase: [number, number];
  shown: boolean; // label survived culling last frame
};

type Pulse = { sprite: THREE.Sprite; from: BrainNode; to: BrainNode; start: number; duration: number; ambient: boolean };

const BACKGROUND = "#04050c";
// Bump when the forces change, so existing brains re-settle once with them.
// Stored per user on the server, so every device shares one layout.
const LAYOUT_VERSION = "5";
const DIM_LINK = "rgba(110,120,180,0.22)";

// Soft radial glow used for neurons, pulses and region nebulae.
function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.55)");
  g.addColorStop(0.5, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function idOf(end: string | BrainNode) {
  return typeof end === "string" ? end : end.id;
}

function pos(n: BrainNode) {
  return new THREE.Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0);
}

export default function Brain3D({
  model,
  layoutVersion,
  onReady,
  onSettled,
  isMobile,
  reducedMotion,
  onSelect,
  onBackground,
  onPositionsSettled,
  ref,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance<BrainNode, BrainLink> | null>(null);
  const visuals = useRef(new Map<string, Visual>());
  const pulses = useRef<Pulse[]>([]);
  const activation = useRef(new Map<string, Activation>());
  // Only the strongest few lit neurons get a label, so text never piles up.
  const labelled = useRef(new Set<string>());
  const selected = useRef<string | null>(null);
  const hovered = useRef<string | null>(null);
  const regionsRef = useRef<{ nebula: THREE.Sprite; label: SpriteText; labelBase: [number, number]; regionId: number }[]>([]);
  const glowTexture = useRef<THREE.Texture | null>(null);
  const settleRef = useRef<{ pending: boolean; ids: Set<string> }>({ pending: false, ids: new Set() });
  // Re-frame once a layout settles (regions spread apart while settling).
  const fitOnStop = useRef(false);
  const needsVersionSave = useRef(false);
  // Framing decisions read the latest isMobile without re-running the scene.
  const mobileRef = useRef(isMobile);
  mobileRef.current = isMobile;
  // The most recent framing request, re-run when the UI's covered area changes.
  const lastFrame = useRef<{ ids: string[] | null; at: number }>({ ids: null, at: 0 });
  // Delayed camera/glow work that any user action cancels.
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  function later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      pendingTimers.current = pendingTimers.current.filter((x) => x !== t);
      fn();
    }, ms);
    pendingTimers.current.push(t);
  }
  function cancelPending() {
    pendingTimers.current.forEach(clearTimeout);
    pendingTimers.current = [];
    fitOnStop.current = false;
  }
  const callbacks = useRef({ onSelect, onBackground, onPositionsSettled, onReady, onSettled });
  callbacks.current = { onSelect, onBackground, onPositionsSettled, onReady, onSettled };
  const settledOnce = useRef(false);
  const modelRef = useRef(model);
  const nodeIndex = useRef(new Map<string, BrainNode>());
  const viewShift = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const occlusion = useRef({ top: 110, bottom: 90, right: 0 });
  const lastInteraction = useRef(0);
  const paused = useRef(false);
  const wakeRef = useRef<() => void>(() => {});

  // --- Scene setup (once) ------------------------------------------------------
  useEffect(() => {
    const el = container.current!;
    glowTexture.current = makeGlowTexture();
    const graph = (new ForceGraph3D(el, { controlType: "orbit" }) as unknown as ForceGraph3DInstance<BrainNode, BrainLink>)
      .backgroundColor(BACKGROUND)
      .showNavInfo(false)
      .width(el.clientWidth)
      .height(el.clientHeight)
      .nodeLabel(() => "")
      .enableNodeDrag(false)
      .nodeThreeObject((node) => createNeuron(node))
      .linkOpacity(0.55)
      .linkWidth(0)
      .linkColor((l) => linkColor(l))
      .d3VelocityDecay(0.35)
      .onNodeClick((node) => callbacks.current.onSelect(node.id))
      .onBackgroundClick(() => callbacks.current.onBackground())
      .onNodeHover((node) => {
        hovered.current = node?.id ?? null;
        el.style.cursor = node ? "pointer" : "grab";
      })
      .onEngineStop(() => {
        if (fitOnStop.current) {
          fitOnStop.current = false;
          frameThoughts(null, 1200);
        }
        const settle = settleRef.current;
        const nodes = graph.graphData().nodes;
        nodes.forEach((n) => {
          if (!n.embedded) return;
          n.fx = n.fy = n.fz = undefined;
        });
        if (!settledOnce.current) {
          settledOnce.current = true;
          callbacks.current.onSettled?.();
        }
        if (!settle.pending) return;
        settle.pending = false;
        // The version is recorded only once the positions it describes are saved.
        const version = needsVersionSave.current ? LAYOUT_VERSION : null;
        needsVersionSave.current = false;
        callbacks.current.onPositionsSettled(version, 
          nodes
            .filter((n) => n.embedded)
            .map((n) => ({
              id: n.id,
              x: Math.round((n.x ?? 0) * 100) / 100,
              y: Math.round((n.y ?? 0) * 100) / 100,
              z: Math.round((n.z ?? 0) * 100) / 100,
            })),
        );
      });
    graphRef.current = graph;

    graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.75 : 2));
    // A colour-managed scene background renders identically with and without
    // post-processing; the library's clear colour gets gamma-lifted to grey
    // once the bloom composer is in the pipeline.
    graph.scene().background = new THREE.Color(BACKGROUND);
    // Real bloom on desktop; phones rely on the additive glow sprites (cheaper).
    if (!isMobile) {
      // High threshold: only neurons and pulses bloom, not nebulae or dust,
      // which would otherwise lift the whole background to grey.
      const composer = graph.postProcessingComposer();
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(el.clientWidth, el.clientHeight), 0.7, 0.45, 0.35));
      // The library's composer lacks the final colour-space pass.
      composer.addPass(new OutputPass());
    }

    // Forces, tuned offline on 42 real facts (vs. the first version: regions
    // 60% further apart, link lengths 39% and neighbour spacing 52% more even):
    // similar thoughts sit close; regions hold together like lobes and keep a
    // clear gap from each other; neurons never overlap.
    const linkForce = graph.d3Force("link") as unknown as
      | { distance: (fn: (l: BrainLink) => number) => { strength: (fn: (l: BrainLink) => number) => void } }
      | undefined;
    // Bridges between regions are long and weak, so they don't drag lobes
    // into each other (d3's default strength made them pull as hard as
    // links inside a region).
    linkForce
      ?.distance((l) => (sameRegion(l) ? 22 + (1 - l.weight) * 18 : 90))
      .strength((l) => (sameRegion(l) ? 1 / Math.max(1, Math.min(degreeOf(l.source), degreeOf(l.target))) : 0.04));
    const charge = graph.d3Force("charge") as unknown as
      | { strength: (n: number) => { distanceMax: (n: number) => void } }
      | undefined;
    charge?.strength(-15).distanceMax(90);
    graph.d3Force("collide", forceCollide(12).strength(0.9).iterations(2));
    graph.d3Force("region", regionCohesion());
    graph.d3Force("separation", regionSeparation());
    graph.d3Force("gravity", gravity());

    // Star dust for depth.
    const dust = new THREE.BufferGeometry();
    const count = isMobile ? 500 : 900;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 350 + Math.random() * 450;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions.set([r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)], i * 3);
    }
    dust.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    // Round, soft dust (bare points render as squares).
    const dustPoints = new THREE.Points(
      dust,
      new THREE.PointsMaterial({
        color: "#7f8dff",
        size: 2.4,
        map: glowTexture.current,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    graph.scene().add(dustPoints);

    // Slow auto-rotation until the user takes over; resumes after a while.
    const controls = graph.controls() as { autoRotate: boolean; autoRotateSpeed: number; addEventListener: (e: string, fn: () => void) => void };
    controls.autoRotate = !reducedMotion;
    controls.autoRotateSpeed = 0.5;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    controls.addEventListener("start", () => {
      controls.autoRotate = false;
      clearTimeout(idleTimer);
    });
    controls.addEventListener("end", () => {
      clearTimeout(idleTimer);
      if (!reducedMotion) idleTimer = setTimeout(() => (controls.autoRotate = true), 25_000);
    });

    const resize = new ResizeObserver(() => {
      wakeRef.current();
      graph.width(el.clientWidth).height(el.clientHeight);
    });
    const onVisible = () => {
      if (!document.hidden) wakeRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    resize.observe(el);

    // --- Animation loop: twinkle, activation glow, pulses, regions ---------------
    let frame = 0;
    let lastSpark = 0;
    // Battery: stop rendering after a quiet spell; any touch wakes it.
    const wakeUp = () => {
      lastInteraction.current = performance.now();
      if (paused.current) {
        paused.current = false;
        graph.resumeAnimation();
      }
    };
    wakeRef.current = wakeUp;
    lastInteraction.current = performance.now();
    // Touching the brain means the user is in charge: no automatic re-framing.
    const onTouch = () => {
      cancelPending();
      wakeUp();
    };
    el.addEventListener("pointerdown", onTouch);
    el.addEventListener("wheel", wakeUp, { passive: true });
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden || paused.current) return;
      // Ambient sparks don't count as activity; real firing does.
      if (t - lastInteraction.current > 45_000 && !pulses.current.some((p) => !p.ambient)) {
        paused.current = true;
        graph.pauseAnimation();
        return;
      }
      // Ease the picture up/down when a bottom sheet opens or closes.
      const shift = viewShift.current;
      if (Math.abs(shift.tx - shift.x) > 0.001 || Math.abs(shift.ty - shift.y) > 0.001) {
        shift.x += (shift.tx - shift.x) * 0.15;
        shift.y += (shift.ty - shift.y) * 0.15;
        const w = graph.width();
        const h = graph.height();
        const camera = graph.camera() as THREE.PerspectiveCamera;
        if (Math.abs(shift.x) < 0.002 && Math.abs(shift.y) < 0.002 && shift.tx === 0 && shift.ty === 0) camera.clearViewOffset();
        else camera.setViewOffset(w, h, shift.x * w, shift.y * h, w, h);
      }

      const anyActive = activation.current.size > 0 || selected.current != null;
      const focus = selected.current ? new Set([selected.current, ...neighborsOf(selected.current)]) : null;

      const labelCandidates: { v: Visual; priority: number }[] = [];
      for (const [id, v] of visuals.current) {
        v.level += (v.target - v.level) * 0.1;
        v.flash *= 0.92;
        const twinkle = reducedMotion ? 0 : Math.sin(t * 0.0012 * v.speed + v.phase) * 0.05;
        const inFocus = (focus?.has(id) ?? false) || v.level > 0.05;
        const dimmed = anyActive && !inFocus;
        const glowOpacity = dimmed ? 0.1 : 0.5 + twinkle + v.level * 0.5 + v.flash;
        (v.glow.material as THREE.SpriteMaterial).opacity = Math.min(1, glowOpacity);
        const scale = v.baseScale * (1 + v.level * 0.6 + v.flash * 0.9 + (id === selected.current ? 0.35 : 0));
        v.glow.scale.set(scale, scale, 1);
        v.coreMaterial.opacity = dimmed ? 0.25 : 1;
        const showLabel = id === selected.current || id === hovered.current || labelled.current.has(id);
        if (showLabel && !v.label) attachLabel(id, v);
        if (v.label) {
          v.label.visible = showLabel;
          if (showLabel) {
            screenScale(v.label, v.labelBase, isMobile ? 17 : 19);
            // Hits read strongest; thoughts reached by the spread are dimmer.
            const strong = id === selected.current || id === hovered.current || v.target >= 0.5;
            (v.label.material as THREE.SpriteMaterial).opacity = strong ? 1 : 0.6;
            v.label.position.set(0, -(v.baseScale * 0.55 + 3), 0);
            // Rank by the target (not the easing value) and favour labels
            // already showing, so near-equal labels don't swap and flicker.
            const priority =
              (id === selected.current ? 3 : id === hovered.current ? 2 : 1 + v.target) + (v.shown ? 0.3 : 0);
            labelCandidates.push({ v, priority });
          }
        }
      }

      // Never let labels pile up: keep the most important, hide any overlap.
      const W = graph.width();
      const H = graph.height();
      // UI bands (chips at the top, bar/panels at the bottom) count as taken.
      const placed: { x0: number; y0: number; x1: number; y1: number }[] = [
        { x0: 0, y0: 0, x1: W, y1: occlusion.current.top },
        { x0: 0, y0: H - occlusion.current.bottom, x1: W, y1: H },
        { x0: W - occlusion.current.right, y0: 0, x1: W, y1: H },
      ];
      const labelPx = isMobile ? 17 : 19;
      labelCandidates.sort((a, b) => b.priority - a.priority);
      for (const { v } of labelCandidates) {
        const label = v.label!;
        const w = label.getWorldPosition(new THREE.Vector3());
        const p = graph.graph2ScreenCoords(w.x, w.y, w.z);
        const width = (v.labelBase[0] / v.labelBase[1]) * labelPx;
        const rect = { x0: p.x - width / 2, y0: p.y - labelPx / 2, x1: p.x + width / 2, y1: p.y + labelPx / 2 };
        const offscreen = rect.x0 < 4 || rect.x1 > W - 4;
        const clash = offscreen || placed.some((o) => rect.x0 < o.x1 && rect.x1 > o.x0 && rect.y0 < o.y1 && rect.y1 > o.y0);
        label.visible = !clash;
        v.shown = !clash;
        if (!clash) placed.push(rect);
      }
      for (const v of visuals.current.values()) if (v.label && !v.label.visible) v.shown = false;

      // Pulses travel neuron to neuron; the target flares when one arrives.
      pulses.current = pulses.current.filter((p) => {
        const k = (t - p.start) / p.duration;
        if (k < 0) return true;
        if (k >= 1) {
          graph.scene().remove(p.sprite);
          (p.sprite.material as THREE.SpriteMaterial).dispose();
          const v = visuals.current.get(p.to.id);
          if (v) v.flash = Math.min(1, v.flash + 0.6);
          return false;
        }
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        p.sprite.position.copy(pos(p.from).lerp(pos(p.to), e));
        const s = 5 + Math.sin(k * Math.PI) * 4;
        p.sprite.scale.set(s, s, 1);
        return true;
      });

      // Ambient sparks along random connections.
      if (!reducedMotion && t - lastSpark > 1400 && t - lastInteraction.current < 30_000 && modelRef.current.links.length) {
        lastSpark = t;
        // Bridges get a disproportionate share of the sparks.
        const links = modelRef.current.links;
        const bridges = links.filter((l) => {
          const a = nodeById(idOf(l.source));
          const b = nodeById(idOf(l.target));
          return a?.region != null && b?.region != null && a.region !== b.region;
        });
        const pool = bridges.length && Math.random() < 0.4 ? bridges : links;
        const l = pool[Math.floor(Math.random() * pool.length)];
        const [a, b] = [l.source, l.target].map((e) => nodeById(idOf(e)));
        if (a && b) {
          const [from, to] = Math.random() < 0.5 ? [a, b] : [b, a];
          spawnPulse(from, to, 0, 1600, 0.45, true);
        }
      }

      // Region nebulae and names follow their members.
      for (const r of regionsRef.current) {
        const region = modelRef.current.regions[r.regionId];
        const members = (region?.members ?? []).map(nodeById).filter((n): n is BrainNode => !!n);
        r.nebula.visible = r.label.visible = members.length > 0;
        if (!members.length) continue;
        const c = members.reduce((acc, n) => acc.add(pos(n)), new THREE.Vector3()).divideScalar(members.length);
        const spread = Math.sqrt(members.reduce((s, n) => s + pos(n).distanceToSquared(c), 0) / members.length);
        r.nebula.position.copy(c);
        // Each lobe breathes slowly, in sync, so the brain feels alive.
        const breath = reducedMotion ? 1 : 1 + Math.sin(t * 0.0009 + r.regionId * 1.7) * 0.05;
        const size = Math.max(40, spread * 3.2) * breath;
        r.nebula.scale.set(size, size, 1);
        const regionActive = anyActive && members.some((n) => (visuals.current.get(n.id)?.level ?? 0) > 0.05 || focus?.has(n.id));
        (r.nebula.material as THREE.SpriteMaterial).opacity = anyActive ? (regionActive ? 0.26 : 0.04) : isMobile ? 0.22 : 0.16;
        // Above the region's highest neuron, never on top of one.
        const top = Math.max(...members.map((n) => (n.y ?? 0) - c.y));
        r.label.position.set(c.x, c.y + top + 10, c.z);
        screenScale(r.label, r.labelBase, isMobile ? 13 : 15);
        // Region names follow the same rules as labels: not under the UI, not
        // over another label, and only for lit regions while something fires.
        const sp = graph.graph2ScreenCoords(r.label.position.x, r.label.position.y, r.label.position.z);
        const rw = (r.labelBase[0] / r.labelBase[1]) * (isMobile ? 13 : 15);
        const rr = { x0: sp.x - rw / 2, y0: sp.y - 8, x1: sp.x + rw / 2, y1: sp.y + 8 };
        const blocked = rr.x0 < 4 || rr.x1 > W - 4 || placed.some((o) => rr.x0 < o.x1 && rr.x1 > o.x0 && rr.y0 < o.y1 && rr.y1 > o.y0);
        if (blocked || (anyActive && !regionActive)) r.label.visible = false;
        else placed.push(rr);
        (r.label.material as THREE.SpriteMaterial).opacity = anyActive && !regionActive ? 0.25 : 0.9;
      }
    };
    frame = requestAnimationFrame(tick);
    const visualMap = visuals.current;

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(idleTimer);
      el.removeEventListener("pointerdown", onTouch);
      el.removeEventListener("wheel", wakeUp);
      document.removeEventListener("visibilitychange", onVisible);
      resize.disconnect();
      graph._destructor();
      glowTexture.current?.dispose();
      dust.dispose();
      visualMap.clear();
      el.innerHTML = "";
    };
    // Scene is created once; data changes are applied in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Helpers (closures over refs) ----------------------------------------------
  function nodeById(id: string): BrainNode | undefined {
    return nodeIndex.current.get(id);
  }

  function setModel(next: BrainModel) {
    modelRef.current = next;
    nodeIndex.current = new Map(next.nodes.map((n) => [n.id, n]));
    // Keep link counts current after births, edits and deletes.
    const degree = new Map<string, number>();
    for (const l of next.links) {
      degree.set(idOf(l.source), (degree.get(idOf(l.source)) ?? 0) + 1);
      degree.set(idOf(l.target), (degree.get(idOf(l.target)) ?? 0) + 1);
    }
    next.nodes.forEach((n) => (n.degree = degree.get(n.id) ?? 0));
  }

  function sameRegion(l: BrainLink) {
    const a = nodeById(idOf(l.source));
    const b = nodeById(idOf(l.target));
    return !!a && !!b && a.region != null && a.region === b.region;
  }

  function degreeOf(end: string | BrainNode) {
    return nodeById(idOf(end))?.degree ?? 1;
  }

  function neighborsOf(id: string): string[] {
    const out: string[] = [];
    for (const l of modelRef.current.links) {
      const s = idOf(l.source);
      const t = idOf(l.target);
      if (s === id) out.push(t);
      else if (t === id) out.push(s);
    }
    return out;
  }

  function linkColor(l: BrainLink) {
    const s = idOf(l.source);
    const t = idOf(l.target);
    const sel = selected.current;
    if (sel && (s === sel || t === sel)) return "#ffffff";
    const a = activation.current;
    if (a.size && a.has(s) && a.has(t)) return "rgba(255,255,255,0.85)";
    if (a.size || sel) return "rgba(90,95,140,0.12)";
    const ns = nodeById(s);
    const nt = nodeById(t);
    if (ns && nt && ns.region != null && ns.region === nt.region) return ns.color;
    // Bridges between regions: the interesting links, drawn in both colours.
    if (ns && nt && ns.region != null && nt.region != null) {
      return `#${new THREE.Color(ns.color).lerp(new THREE.Color(nt.color), 0.5).lerp(new THREE.Color("#ffffff"), 0.35).getHexString()}`;
    }
    return DIM_LINK;
  }

  function refreshLinks() {
    graphRef.current?.linkColor((l: BrainLink) => linkColor(l));
  }

  function createNeuron(node: BrainNode) {
    const group = new THREE.Group();
    const color = new THREE.Color(node.embedded ? node.color : LONE_COLOR);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: color.clone().lerp(new THREE.Color("#ffffff"), 0.35),
      transparent: true,
    });
    // Sized for the spread-out layout (regions sit well apart).
    // Phones get no bloom, so their cores are larger to read at a glance.
    const radius = (1.3 + Math.min(1.5, Math.sqrt(node.degree) * 0.45)) * (isMobile ? 1.4 : 1);
    const core = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), coreMaterial);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture.current,
        color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.6,
      }),
    );
    const baseScale = (node.embedded ? 16 : 10) + Math.min(14, node.degree * 2.5);
    glow.scale.set(baseScale, baseScale, 1);
    group.add(glow, core);
    const existing = visuals.current.get(node.id);
    visuals.current.set(node.id, {
      group,
      core,
      coreMaterial,
      glow,
      baseScale,
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 0.8,
      level: existing?.level ?? 0,
      target: existing?.target ?? 0,
      flash: existing?.flash ?? 0,
      label: null,
      labelBase: [0, 0],
      shown: false,
    });
    return group;
  }

  function attachLabel(id: string, v: Visual) {
    const node = nodeById(id);
    if (!node) return;
    const text = node.caption.length > 48 ? `${node.caption.slice(0, 47)}…` : node.caption;
    const label = new SpriteText(text, 3.2, "rgba(235,240,255,0.95)");
    label.fontFace = "system-ui, -apple-system, sans-serif";
    label.backgroundColor = "rgba(6,8,20,0.55)";
    label.padding = 1.5;
    label.borderRadius = 2;
    label.position.set(0, -(v.baseScale * 0.45 + 3), 0);
    // Text always draws over neuron cores.
    (label.material as THREE.SpriteMaterial).depthWrite = false;
    (label.material as THREE.SpriteMaterial).depthTest = false;
    label.renderOrder = 10;
    v.group.add(label);
    v.label = label;
    v.labelBase = [label.scale.x, label.scale.y];
  }

  // Sprite text is sized in world units; rescale by camera distance so labels
  // stay readable (never huge, never tiny) at any zoom.
  function screenScale(object: THREE.Object3D, base: [number, number], pixels: number) {
    const camera = graphRef.current!.camera() as THREE.PerspectiveCamera;
    const world = object.getWorldPosition(new THREE.Vector3());
    const distance = camera.position.distanceTo(world);
    const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance;
    const h = (pixels / (graphRef.current!.height() || 800)) * viewHeight;
    object.scale.set((base[0] / base[1]) * h, h, 1);
  }

  function spawnPulse(from: BrainNode, to: BrainNode, delay: number, duration: number, opacity = 1, ambient = false) {
    const graph = graphRef.current;
    if (!graph) return;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture.current,
        color: new THREE.Color(to.color).lerp(new THREE.Color("#ffffff"), 0.5),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity,
      }),
    );
    sprite.position.copy(pos(from));
    sprite.scale.set(0.01, 0.01, 1);
    graph.scene().add(sprite);
    pulses.current.push({ sprite, from, to, start: performance.now() + delay, duration, ambient });
  }

  // Gentle pull toward the centre so regions pack together like lobes of one
  // brain instead of drifting apart into separate constellations.
  function gravity() {
    let nodes: BrainNode[] = [];
    const force = (alpha: number) => {
      // Same in every direction: positions are shared by phone and laptop,
      // and the camera framing adapts to each screen's shape.
      const k = 0.035 * alpha;
      for (const n of nodes) {
        if (n.fx != null) continue;
        n.vx = (n.vx ?? 0) - (n.x ?? 0) * k;
        n.vy = (n.vy ?? 0) - (n.y ?? 0) * k;
        n.vz = (n.vz ?? 0) - (n.z ?? 0) * k;
      }
    };
    force.initialize = (n: BrainNode[]) => (nodes = n);
    return force;
  }

  // Pushes regions apart until there's a clear gap between them, so lobes
  // read as distinct.
  function regionSeparation() {
    let nodes: BrainNode[] = [];
    const force = (alpha: number) => {
      const groups = new Map<number, BrainNode[]>();
      for (const n of nodes) {
        if (n.region == null) continue;
        const g = groups.get(n.region) ?? [];
        g.push(n);
        groups.set(n.region, g);
      }
      const regions = [...groups.values()].map((m) => {
        const c = m.reduce((acc, n) => acc.add(pos(n)), new THREE.Vector3()).divideScalar(m.length);
        const r = Math.sqrt(m.reduce((s, n) => s + pos(n).distanceToSquared(c), 0) / m.length);
        return { m, c, r };
      });
      for (let i = 0; i < regions.length; i++) {
        for (let j = i + 1; j < regions.length; j++) {
          const a = regions[i];
          const b = regions[j];
          let v = b.c.clone().sub(a.c);
          let d = v.length();
          // Coincident centres would never separate; pick a direction.
          if (d < 0.5) {
            v = new THREE.Vector3().randomDirection();
            d = 1;
          }
          // RMS radius understates a region's extent, so ask for a wide gap.
          const want = (a.r + b.r) * 1.8 + 12;
          if (d >= want) continue;
          // Clamped, so many overlapping pairs can't add up to a jolt.
          const push = (Math.min(want - d, 14) * 0.6 * alpha) / d;
          for (const n of a.m) {
            if (n.fx != null) continue;
            n.vx = (n.vx ?? 0) - v.x * push;
            n.vy = (n.vy ?? 0) - v.y * push;
            n.vz = (n.vz ?? 0) - v.z * push;
          }
          for (const n of b.m) {
            if (n.fx != null) continue;
            n.vx = (n.vx ?? 0) + v.x * push;
            n.vy = (n.vy ?? 0) + v.y * push;
            n.vz = (n.vz ?? 0) + v.z * push;
          }
        }
      }
    };
    force.initialize = (n: BrainNode[]) => (nodes = n);
    return force;
  }

  // Pulls each region's thoughts toward the region's centre (d3 custom force).
  function regionCohesion() {
    let nodes: BrainNode[] = [];
    const force = (alpha: number) => {
      const sums = new Map<number, { x: number; y: number; z: number; n: number }>();
      for (const n of nodes) {
        if (n.region == null) continue;
        const s = sums.get(n.region) ?? { x: 0, y: 0, z: 0, n: 0 };
        s.x += n.x ?? 0;
        s.y += n.y ?? 0;
        s.z += n.z ?? 0;
        s.n++;
        sums.set(n.region, s);
      }
      for (const n of nodes) {
        if (n.region == null || n.fx != null) continue;
        const s = sums.get(n.region)!;
        const k = 0.08 * alpha;
        n.vx = (n.vx ?? 0) + (s.x / s.n - (n.x ?? 0)) * k;
        n.vy = (n.vy ?? 0) + (s.y / s.n - (n.y ?? 0)) * k;
        n.vz = (n.vz ?? 0) + (s.z / s.n - (n.z ?? 0)) * k;
      }
    };
    force.initialize = (n: BrainNode[]) => (nodes = n);
    return force;
  }

  function buildRegions() {
    const graph = graphRef.current!;
    for (const r of regionsRef.current) {
      graph.scene().remove(r.nebula, r.label);
      (r.nebula.material as THREE.SpriteMaterial).dispose();
    }
    regionsRef.current = modelRef.current.regions.map((region) => {
      const nebula = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture.current,
          color: region.color,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          opacity: 0.11,
        }),
      );
      const label = new SpriteText(region.name.toUpperCase(), isMobile ? 5.5 : 4.5, region.color);
      label.fontFace = "system-ui, -apple-system, sans-serif";
      label.fontWeight = "600";
      (label.material as THREE.SpriteMaterial).depthWrite = false;
      label.renderOrder = 5;
      graph.scene().add(nebula, label);
      return { nebula, label, labelBase: [label.scale.x, label.scale.y] as [number, number], regionId: region.id };
    });
  }

  // Re-applies the model to the graph. Settled thoughts stay pinned; `moving`
  // ones (plus any still settling after a birth) are free to find their place,
  // and their new positions are saved when the simulation stops.
  function rewire(moving: string[]) {
    const graph = graphRef.current;
    if (!graph) return;
    const settle = settleRef.current;
    const free = new Set([...(settle.pending ? settle.ids : []), ...moving]);
    modelRef.current.nodes.forEach((n) => {
      if (!n.embedded) return; // parked on the outer shell, fixed
      if (free.has(n.id)) {
        n.fx = n.fy = n.fz = undefined;
      } else {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = n.z;
      }
    });
    if (moving.length) settleRef.current = { pending: true, ids: free };
    graph
      .cooldownTime(free.size ? 1800 : 0)
      .cooldownTicks(free.size ? Infinity : 0)
      .graphData({ nodes: modelRef.current.nodes, links: modelRef.current.links });
    refreshLinks();
  }

  // Frames the given thoughts so they fit on screen from any rotation angle:
  // fits their bounding sphere against the narrower of the vertical and
  // horizontal fields of view (zoomToFit used only the box, so portrait
  // phones clipped regions as the brain rotated). One thought: fly to it.
  function frameThoughts(ids: string[] | null, ms: number, rerun = false) {
    const graph = graphRef.current;
    if (!graph) return;
    // A re-run (after the UI's covered area changed) must not extend its own window.
    if (!rerun) lastFrame.current = { ids, at: performance.now() };
    let nodes = (ids ? ids.map(nodeById) : modelRef.current.nodes).filter((n): n is BrainNode => !!n && n.x != null);
    // "Everything" means connected thoughts: the unprocessed ones on the outer
    // shell would zoom the whole brain out.
    if (!ids && nodes.some((n) => n.embedded)) nodes = nodes.filter((n) => n.embedded);
    if (nodes.length === 0) return;
    // Centre on the bounding box (not the centroid, which an outlying region
    // drags off-centre). The brain auto-rotates about its vertical axis, so
    // fit height to the vertical extent and width to the widest radius in the
    // horizontal plane.
    const box = new THREE.Box3().setFromPoints(nodes.map(pos));
    const c = box.getCenter(new THREE.Vector3());
    // For the whole brain, fit the 85th percentile: a lone outlier may sit
    // slightly off-screen rather than shrink everything else.
    const extent = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return ids || sorted.length < 8 ? sorted[sorted.length - 1] : sorted[Math.floor(sorted.length * 0.85)];
    };
    const halfY = Math.max(15, extent(nodes.map((n) => Math.abs((n.y ?? 0) - c.y)))) + 8;
    const radXZ = Math.max(15, extent(nodes.map((n) => Math.hypot((n.x ?? 0) - c.x, (n.z ?? 0) - c.z)))) + 8;
    const camera = graph.camera() as THREE.PerspectiveCamera;
    // Fit into the part of the screen the UI leaves visible.
    const W = graph.width();
    const H = graph.height();
    const occ = occlusion.current;
    const visH = Math.max(H * 0.15, H - occ.top - occ.bottom);
    const visW = Math.max(W * 0.3, W - occ.right);
    const vFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (visH / H));
    const hFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (visW / H));
    // Depth adds to the distance: the nearest points must not poke past the frame.
    const distance = Math.max(
      mobileRef.current ? 110 : 90,
      halfY / Math.tan(vFov / 2) + radXZ,
      radXZ / Math.tan(hFov / 2) + radXZ,
    );
    const dir = camera.position.clone().sub(c).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0, 0, 1);
    const to = c.clone().add(dir.multiplyScalar(distance));
    graph.cameraPosition({ x: to.x, y: to.y, z: to.z }, { x: c.x, y: c.y, z: c.z }, reducedMotion ? 0 : ms);
  }

  // The region most of these neighbours belong to.
  function voteRegion(neighborIds: string[]): number | null {
    const votes = new Map<number, number>();
    for (const id of neighborIds) {
      const r = nodeById(id)?.region;
      if (r != null) votes.set(r, (votes.get(r) ?? 0) + 1);
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  // Moves a thought between regions and recolours its neuron.
  function setRegion(node: BrainNode, region: number | null) {
    const regions = modelRef.current.regions;
    if (node.region === region) return;
    if (node.region != null) regions[node.region].members = regions[node.region].members.filter((m) => m !== node.id);
    if (region != null) regions[region].members.push(node.id);
    node.region = region;
    node.color = region == null ? LONE_COLOR : regions[region].color;
    const v = visuals.current.get(node.id);
    if (v) {
      const color = new THREE.Color(node.color);
      v.coreMaterial.color.copy(color.clone().lerp(new THREE.Color("#ffffff"), 0.35));
      (v.glow.material as THREE.SpriteMaterial).color.copy(color);
    }
  }

  // --- Data -> scene ----------------------------------------------------------------
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    setModel(model);
    const nodes = model.nodes;
    // New layout rules: let everything find its place once more. Unknown
    // (settings table missing) never triggers a relayout.
    const relayout = layoutVersion !== null && layoutVersion !== LAYOUT_VERSION;
    needsVersionSave.current = layoutVersion !== null && layoutVersion !== LAYOUT_VERSION;
    if (relayout) {
      nodes.forEach((n) => {
        n.x = n.y = n.z = undefined;
      });
    }
    const placed = nodes.filter((n) => n.embedded && n.x != null && n.y != null && n.z != null);
    const unplaced = nodes.filter((n) => n.embedded && (n.x == null || n.y == null || n.z == null));
    const firstLayout = placed.length === 0;
    const radius = Math.max(60, Math.cbrt(nodes.length) * 30);

    // Saved thoughts stay put while new ones find their place.
    placed.forEach((n) => {
      n.fx = n.x!;
      n.fy = n.y!;
      n.fz = n.z!;
    });
    if (!firstLayout) {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      unplaced.forEach((n) => {
        const anchors = model.links
          .map((l) => (idOf(l.source) === n.id ? idOf(l.target) : idOf(l.target) === n.id ? idOf(l.source) : null))
          .map((id) => (id ? byId.get(id) : undefined))
          .filter((a): a is BrainNode => !!a && a.x != null);
        const jitter = () => (Math.random() - 0.5) * 12;
        const c = anchors.length
          ? anchors.reduce((acc, a) => acc.add(pos(a)), new THREE.Vector3()).divideScalar(anchors.length)
          : new THREE.Vector3((Math.random() - 0.5) * radius, (Math.random() - 0.5) * radius, (Math.random() - 0.5) * radius);
        n.x = c.x + jitter();
        n.y = c.y + jitter();
        n.z = c.z + jitter();
      });
    }
    // Unconnected (not yet embedded) thoughts orbit on an outer shell.
    const parked = nodes.filter((n) => !n.embedded);
    parked.forEach((n, i) => {
      const phi = Math.acos(1 - (2 * (i + 0.5)) / parked.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = radius * 1.6;
      n.fx = n.x = r * Math.sin(phi) * Math.cos(theta);
      n.fy = n.y = r * Math.sin(phi) * Math.sin(theta);
      n.fz = n.z = r * Math.cos(phi);
    });

    settleRef.current = { pending: unplaced.length > 0, ids: new Set(unplaced.map((n) => n.id)) };
    fitOnStop.current = unplaced.length > 0;
    graph
      .cooldownTime(unplaced.length ? (firstLayout ? 7000 : 2500) : 0)
      .cooldownTicks(unplaced.length ? Infinity : 0)
      .graphData({ nodes, links: model.links });
    buildRegions();
    refreshLinks();
    later(() => frameThoughts(null, firstLayout ? 1500 : 900), firstLayout ? 2500 : 300);
    setTimeout(() => callbacks.current.onReady?.(), 0);
    // Only data changes re-apply the scene (a resize mid-settle must not pin
    // half-settled positions); helpers only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // --- Imperative API for the UI ---------------------------------------------------------
  useImperativeHandle(ref, () => ({
    activate(seedIds, options) {
      wakeRef.current();
      cancelPending();
      const result = spreadActivation(seedIds, modelRef.current.links, options);
      activation.current = result;
      labelled.current = new Set(
        [...result.values()]
          .sort((a, b) => b.level - a.level)
          .slice(0, 5)
          .map((a) => a.id),
      );
      for (const [id, v] of visuals.current) v.target = result.get(id)?.level ?? 0;
      // Fire: seeds burst now, then the signal travels outward hop by hop.
      for (const a of result.values()) {
        const v = visuals.current.get(a.id);
        if (a.hop === 0) {
          if (v) v.flash = 1;
          continue;
        }
        const from = a.from ? nodeById(a.from) : undefined;
        const to = nodeById(a.id);
        if (from && to) spawnPulse(from, to, reducedMotion ? 0 : (a.hop - 1) * 320, reducedMotion ? 1 : 520);
      }
      refreshLinks();
      return result;
    },
    clearActivation() {
      wakeRef.current();
      cancelPending();
      activation.current = new Map();
      labelled.current = new Set();
      for (const v of visuals.current.values()) v.target = 0;
      refreshLinks();
    },
    flyToNode(id) {
      wakeRef.current();
      cancelPending();
      lastFrame.current.at = 0; // a flight, not a framing: never re-frame over it
      const graph = graphRef.current;
      const n = nodeById(id);
      if (!graph || !n) return;
      const target = pos(n);
      const cam = graph.camera().position.clone();
      const dir = cam.sub(target).normalize();
      // Close enough to read, far enough to see its neighbourhood.
      const reach = neighborsOf(id).reduce((m, nb) => {
        const other = nodeById(nb);
        return other ? Math.max(m, pos(other).distanceTo(target)) : m;
      }, 0);
      const distance = Math.min(300, Math.max(isMobile ? 130 : 100, reach * (isMobile ? 3.2 : 2.4)));
      const to = target.clone().add(dir.multiplyScalar(distance));
      (graph.controls() as { autoRotate: boolean }).autoRotate = false;
      graph.cameraPosition({ x: to.x, y: to.y, z: to.z }, { x: target.x, y: target.y, z: target.z }, reducedMotion ? 0 : 1200);
    },
    // Frame everything that lit up, so you see the signal spread.
    focusActivation() {
      wakeRef.current();
      cancelPending();
      const graph = graphRef.current;
      const lit = activation.current;
      if (!graph || !lit.size) return;
      (graph.controls() as { autoRotate: boolean }).autoRotate = false;
      frameThoughts(
        [...lit.values()].filter((a) => a.level > 0.12).map((a) => a.id),
        1200,
      );
    },
    flyToRegion(regionId) {
      wakeRef.current();
      cancelPending();
      const graph = graphRef.current;
      const region = modelRef.current.regions[regionId];
      if (!graph || !region) return;
      (graph.controls() as { autoRotate: boolean }).autoRotate = false;
      frameThoughts(region.members, 1200);
    },
    fitAll() {
      wakeRef.current();
      frameThoughts(null, 1000);
    },
    select(id) {
      wakeRef.current();
      selected.current = id;
      refreshLinks();
    },
    getModel() {
      return modelRef.current;
    },
    replayBirths(ids) {
      wakeRef.current();
      cancelPending();
      const order = ids.filter((id) => nodeById(id));
      if (!order.length) return;
      frameThoughts(order.length > 1 ? order : null, 1200);
      order.forEach((id, i) => {
        later(() => {
          const n = nodeById(id);
          const v = visuals.current.get(id);
          if (!n || !v) return;
          v.flash = 1;
          neighborsOf(id).forEach((nb, j) => {
            const other = nodeById(nb);
            if (other) spawnPulse(n, other, j * 150, 650);
          });
        }, reducedMotion ? 0 : 1300 + i * 700);
      });
    },
    stir(id) {
      wakeRef.current();
      cancelPending();
      lastFrame.current.at = 0; // a flight, not a framing: never re-frame over it
      const graph = graphRef.current;
      const n = nodeById(id);
      const v = visuals.current.get(id);
      if (!graph || !n || !v) return;
      (graph.controls() as { autoRotate: boolean }).autoRotate = false;
      // A slow drift, wider than a tap, so its neighbourhood stays in view.
      const target = pos(n);
      const dir = graph.camera().position.clone().sub(target).normalize();
      const to = target.clone().add(dir.multiplyScalar(mobileRef.current ? 190 : 150));
      graph.cameraPosition({ x: to.x, y: to.y, z: to.z }, { x: target.x, y: target.y, z: target.z }, reducedMotion ? 0 : 2600);
      // It wakes: a soft glow that swells, then signals to its neighbours.
      later(() => {
        v.target = 0.7;
        v.flash = 0.8;
        labelled.current = new Set([id]);
        neighborsOf(id).forEach((nb, i) => {
          const other = nodeById(nb);
          if (other) spawnPulse(n, other, 600 + i * 350, 1400, 0.8);
        });
      }, reducedMotion ? 0 : 2200);
    },
    setOcclusion(top, bottom, right) {
      const prev = occlusion.current;
      occlusion.current = { top, bottom, right };
      // A sheet that just opened changes the free space: re-frame the latest
      // request (e.g. the region you just tapped) to fit what's left.
      const changed = Math.abs(prev.top - top) + Math.abs(prev.bottom - bottom) + Math.abs(prev.right - right) > 24;
      if (changed && performance.now() - lastFrame.current.at < 1500) frameThoughts(lastFrame.current.ids, 600, true);
    },
    setViewShift(x, y) {
      wakeRef.current();
      viewShift.current.tx = x;
      viewShift.current.ty = y;
    },
    pulseFrom(id) {
      wakeRef.current();
      const from = nodeById(id);
      const v = visuals.current.get(id);
      if (v) v.flash = 1;
      if (!from) return;
      neighborsOf(id).forEach((n, i) => {
        const to = nodeById(n);
        if (to) spawnPulse(from, to, i * 120, 600);
      });
    },
    addThought(node, neighbors) {
      wakeRef.current();
      const graph = graphRef.current;
      if (!graph) return [];
      const current = modelRef.current;
      if (current.nodes.some((n) => n.id === node.id)) return [];
      const byId = new Map(current.nodes.map((n) => [n.id, n]));
      const top = neighbors
        .filter((e) => byId.has(e.target))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, defaultK(current.nodes.length + 1));
      // Join the region most of its neighbours belong to.
      const region = voteRegion(top.map((e) => e.target));
      // Born just in front of the camera, then pulled to where it belongs.
      const cam = graph.camera().position;
      const birth = cam.clone().multiplyScalar(0.5);
      const brainNode: BrainNode = {
        id: node.id,
        caption: node.caption,
        tags: node.tags,
        embedded: node.embedded,
        x: birth.x,
        y: birth.y,
        z: birth.z,
        region,
        color: region == null ? LONE_COLOR : current.regions[region].color,
        degree: top.length,
      };
      const links: BrainLink[] = top.map((e) => ({ key: `${node.id}-${e.target}`, source: node.id, target: e.target, weight: 0.75 }));
      if (region != null) current.regions[region].members.push(node.id);
      setModel({ ...current, nodes: [...current.nodes, brainNode], links: [...current.links, ...links] });
      rewire(node.embedded ? [node.id] : []);
      // Connections light up as the new neuron settles.
      setTimeout(() => {
        const v = visuals.current.get(node.id);
        if (v) v.flash = 1;
        const from = nodeById(node.id);
        top.forEach((e, i) => {
          const to = nodeById(e.target);
          if (from && to) {
            spawnPulse(from, to, i * 200, 700);
            spawnPulse(to, from, 900 + i * 200, 700, 0.7);
          }
        });
      }, reducedMotion ? 0 : 1600);
      return top.map((e) => e.target);
    },
    updateThought(node, neighbors) {
      wakeRef.current();
      const current = modelRef.current;
      const existing = nodeById(node.id);
      if (!graphRef.current || !existing) return;
      existing.caption = node.caption;
      existing.tags = node.tags;
      existing.embedded = node.embedded;
      const byId = new Map(current.nodes.map((n) => [n.id, n]));
      const top = neighbors
        .filter((e) => byId.has(e.target) && e.target !== node.id)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, defaultK(current.nodes.length));
      const kept = current.links.filter((l) => idOf(l.source) !== node.id && idOf(l.target) !== node.id);
      const added: BrainLink[] = top.map((e) => ({ key: `${node.id}-${e.target}`, source: node.id, target: e.target, weight: 0.75 }));
      // Its meaning changed: re-vote its region from the new neighbours.
      setRegion(existing, voteRegion(top.map((e) => e.target)));
      setModel({ ...current, links: [...kept, ...added] });
      const v = visuals.current.get(node.id);
      if (v?.label) {
        v.group.remove(v.label);
        v.label = null;
      }
      // Let it drift to where its new connections pull it.
      rewire([node.id]);
      setTimeout(() => {
        const from = nodeById(node.id);
        if (v) v.flash = 1;
        top.forEach((e, i) => {
          const to = nodeById(e.target);
          if (from && to) spawnPulse(from, to, i * 150, 600);
        });
      }, 300);
    },
    removeThought(id) {
      wakeRef.current();
      const current = modelRef.current;
      const node = nodeById(id);
      if (!graphRef.current || !node) return null;
      const links = current.links.filter((l) => idOf(l.source) === id || idOf(l.target) === id);
      const region = node.region;
      if (region != null) current.regions[region].members = current.regions[region].members.filter((m) => m !== id);
      setModel({
        ...current,
        nodes: current.nodes.filter((n) => n.id !== id),
        links: current.links.filter((l) => !links.includes(l)),
      });
      if (selected.current === id) selected.current = null;
      // Forget everything about it: firing state, labels, pulses, GPU memory.
      activation.current.delete(id);
      labelled.current.delete(id);
      pulses.current = pulses.current.filter((p) => {
        if (p.from.id !== id && p.to.id !== id) return true;
        graphRef.current!.scene().remove(p.sprite);
        (p.sprite.material as THREE.SpriteMaterial).dispose();
        return false;
      });
      const v = visuals.current.get(id);
      if (v) {
        v.core.geometry.dispose();
        v.coreMaterial.dispose();
        (v.glow.material as THREE.SpriteMaterial).dispose();
        visuals.current.delete(id);
      }
      settleRef.current.ids.delete(id);
      rewire([]);
      return { node, links, region };
    },
    restoreThought(removed) {
      wakeRef.current();
      const current = modelRef.current;
      if (!graphRef.current || nodeById(removed.node.id)) return;
      if (removed.region != null) current.regions[removed.region]?.members.push(removed.node.id);
      // Only links whose other end still exists.
      const links = removed.links.filter((l) => {
        const other = idOf(l.source) === removed.node.id ? idOf(l.target) : idOf(l.source);
        return !!nodeById(other);
      });
      setModel({ ...current, nodes: [...current.nodes, removed.node], links: [...current.links, ...links] });
      rewire([]);
      setTimeout(() => {
        const v = visuals.current.get(removed.node.id);
        if (v) v.flash = 1;
      }, 50);
    },
  }));

  return <div ref={container} className="absolute inset-0 touch-none" aria-label="3D map of your thoughts" role="img" />;
}
