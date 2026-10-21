"use client";

import dynamic from "next/dynamic";
import type { MapEdge, MapNode } from "@/lib/types";

// Sigma needs WebGL and `window`, so the map only renders in the browser.
const BrainMap = dynamic(() => import("@/components/map/BrainMap"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

export function MapSkeleton() {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg text-sm text-muted">
      <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      Loading your brain…
    </div>
  );
}

export function MapLoader(props: { nodes: MapNode[]; edges: MapEdge[] }) {
  return <BrainMap {...props} />;
}
