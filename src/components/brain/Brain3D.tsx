"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
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
  addThought: (node: MapNode, neighbors: MapEdge[]) => void;
  pulseFrom: (id: string) => void;
  getModel: () => BrainModel;
  // Shift the picture up by this fraction of the height (to clear a bottom sheet).
  setViewShift: (fraction: number) => void;
};

type Props = {
  model: BrainModel;
  isMobile: boolean;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  onBackground: () => void;
  onPositionsSettled: (positions: { id: string; x: number; y: number; z: number }[]) => void;
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
};

type Pulse = { sprite: THREE.Sprite; from: BrainNode; to: BrainNode; start: number; duration: number };

const BACKGROUND = "#04050c";
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

export default function Brain3D({ model, isMobile, reducedMotion, onSelect, onBackground, onPositionsSettled, ref }: Props) {
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
  const callbacks = useRef({ onSelect, onBackground, onPositionsSettled });
  callbacks.current = { onSelect, onBackground, onPositionsSettled };
  const modelRef = useRef(model);
  const nodeIndex = useRef(new Map<string, BrainNode>());
  const viewShift = useRef({ current: 0, target: 0 });

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
        const settle = settleRef.current;
        const nodes = graph.graphData().nodes;
        nodes.forEach((n) => {
          if (!n.embedded) return;
          n.fx = n.fy = n.fz = undefined;
        });
        if (!settle.pending) return;
        settle.pending = false;
        callbacks.current.onPositionsSettled(
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

    // Forces: similar thoughts sit close; regions hold together like lobes.
    const linkForce = graph.d3Force("link") as unknown as { distance: (fn: (l: BrainLink) => number) => void } | undefined;
    linkForce?.distance((l) => 16 + (1 - l.weight) * 38);
    const charge = graph.d3Force("charge") as unknown as
      | { strength: (n: number) => { distanceMax: (n: number) => void } }
      | undefined;
    // Short-range repulsion: keeps neurons apart without flinging regions away.
    charge?.strength(-30).distanceMax(90);
    graph.d3Force("region", regionCohesion());
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

    const resize = new ResizeObserver(() => graph.width(el.clientWidth).height(el.clientHeight));
    resize.observe(el);

    // --- Animation loop: twinkle, activation glow, pulses, regions ---------------
    let frame = 0;
    let lastSpark = 0;
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      // Ease the picture up/down when a bottom sheet opens or closes.
      const shift = viewShift.current;
      if (Math.abs(shift.target - shift.current) > 0.001) {
        shift.current += (shift.target - shift.current) * 0.15;
        const w = graph.width();
        const h = graph.height();
        const camera = graph.camera() as THREE.PerspectiveCamera;
        if (Math.abs(shift.current) < 0.002 && shift.target === 0) camera.clearViewOffset();
        else camera.setViewOffset(w, h, 0, shift.current * h, w, h);
      }

      const anyActive = activation.current.size > 0 || selected.current != null;
      const focus = selected.current ? new Set([selected.current, ...neighborsOf(selected.current)]) : null;

      for (const [id, v] of visuals.current) {
        v.level += (v.target - v.level) * 0.1;
        v.flash *= 0.92;
        const twinkle = reducedMotion ? 0 : Math.sin(t * 0.0012 * v.speed + v.phase) * 0.12;
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
            v.label.position.set(0, -(v.baseScale * 0.4 + 2), 0);
          }
        }
      }

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
      if (!reducedMotion && t - lastSpark > 1400 && modelRef.current.links.length) {
        lastSpark = t;
        const l = modelRef.current.links[Math.floor(Math.random() * modelRef.current.links.length)];
        const [a, b] = [l.source, l.target].map((e) => nodeById(idOf(e)));
        if (a && b) spawnPulse(Math.random() < 0.5 ? a : b, Math.random() < 0.5 ? b : a, 0, 1600, 0.45);
      }

      // Region nebulae and names follow their members.
      for (const r of regionsRef.current) {
        const region = modelRef.current.regions[r.regionId];
        const members = region.members.map(nodeById).filter((n): n is BrainNode => !!n);
        if (!members.length) continue;
        const c = members.reduce((acc, n) => acc.add(pos(n)), new THREE.Vector3()).divideScalar(members.length);
        const spread = Math.sqrt(members.reduce((s, n) => s + pos(n).distanceToSquared(c), 0) / members.length);
        r.nebula.position.copy(c);
        const size = Math.max(40, spread * 3.2);
        r.nebula.scale.set(size, size, 1);
        const regionActive = anyActive && members.some((n) => (visuals.current.get(n.id)?.level ?? 0) > 0.05 || focus?.has(n.id));
        (r.nebula.material as THREE.SpriteMaterial).opacity = anyActive ? (regionActive ? 0.22 : 0.04) : 0.15;
        r.label.position.set(c.x, c.y + spread * 0.9 + 6, c.z);
        screenScale(r.label, r.labelBase, isMobile ? 13 : 15);
        (r.label.material as THREE.SpriteMaterial).opacity = anyActive && !regionActive ? 0.25 : 0.9;
      }
    };
    frame = requestAnimationFrame(tick);
    const visualMap = visuals.current;

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(idleTimer);
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
    const radius = 0.9 + Math.min(1.1, Math.sqrt(node.degree) * 0.35);
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
    const baseScale = (node.embedded ? 11 : 7) + Math.min(10, node.degree * 1.8);
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
    (label.material as THREE.SpriteMaterial).depthWrite = false;
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

  function spawnPulse(from: BrainNode, to: BrainNode, delay: number, duration: number, opacity = 1) {
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
    pulses.current.push({ sprite, from, to, start: performance.now() + delay, duration });
  }

  // Gentle pull toward the centre so regions pack together like lobes of one
  // brain instead of drifting apart into separate constellations.
  function gravity() {
    let nodes: BrainNode[] = [];
    const force = (alpha: number) => {
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

  // --- Data -> scene ----------------------------------------------------------------
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    setModel(model);
    const nodes = model.nodes;
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
    graph
      .cooldownTime(unplaced.length ? (firstLayout ? 7000 : 2500) : 0)
      .cooldownTicks(unplaced.length ? Infinity : 0)
      .graphData({ nodes, links: model.links });
    buildRegions();
    refreshLinks();
    setTimeout(() => graph.zoomToFit(firstLayout ? 1500 : 900, isMobile ? 30 : 60), firstLayout ? 2500 : 300);
    // buildRegions/refreshLinks only touch refs; re-run on data changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, isMobile]);

  // --- Imperative API for the UI ---------------------------------------------------------
  useImperativeHandle(ref, () => ({
    activate(seedIds, options) {
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
      activation.current = new Map();
      labelled.current = new Set();
      for (const v of visuals.current.values()) v.target = 0;
      refreshLinks();
    },
    flyToNode(id) {
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
      const graph = graphRef.current;
      const lit = activation.current;
      if (!graph || !lit.size) return;
      (graph.controls() as { autoRotate: boolean }).autoRotate = false;
      graph.zoomToFit(reducedMotion ? 0 : 1200, isMobile ? 40 : 120, (n) => (lit.get(n.id)?.level ?? 0) > 0.12);
    },
    flyToRegion(regionId) {
      const graph = graphRef.current;
      const region = modelRef.current.regions[regionId];
      if (!graph || !region) return;
      (graph.controls() as { autoRotate: boolean }).autoRotate = false;
      const members = new Set(region.members);
      graph.zoomToFit(reducedMotion ? 0 : 1200, isMobile ? 20 : 80, (n) => members.has(n.id));
    },
    fitAll() {
      graphRef.current?.zoomToFit(reducedMotion ? 0 : 1000, isMobile ? 30 : 60);
    },
    select(id) {
      selected.current = id;
      refreshLinks();
    },
    getModel() {
      return modelRef.current;
    },
    setViewShift(fraction) {
      viewShift.current.target = fraction;
    },
    pulseFrom(id) {
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
      const graph = graphRef.current;
      if (!graph) return;
      const current = modelRef.current;
      if (current.nodes.some((n) => n.id === node.id)) return;
      const byId = new Map(current.nodes.map((n) => [n.id, n]));
      const top = neighbors
        .filter((e) => byId.has(e.target))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, defaultK(current.nodes.length + 1));
      // Join the region most of its neighbours belong to.
      const votes = new Map<number, number>();
      top.forEach((e) => {
        const r = byId.get(e.target)!.region;
        if (r != null) votes.set(r, (votes.get(r) ?? 0) + 1);
      });
      const region = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
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
      current.nodes.forEach((n) => {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = n.z;
      });
      if (region != null) current.regions[region].members.push(node.id);
      setModel({ ...current, nodes: [...current.nodes, brainNode], links: [...current.links, ...links] });
      settleRef.current = { pending: node.embedded, ids: new Set([node.id]) };
      graph
        .cooldownTime(2500)
        .cooldownTicks(Infinity)
        .graphData({ nodes: modelRef.current.nodes, links: modelRef.current.links });
      refreshLinks();
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
    },
  }));

  return <div ref={container} className="absolute inset-0 touch-none" aria-label="3D map of your thoughts" role="img" />;
}
