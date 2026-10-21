import type { Metadata } from "next";
import { Suspense } from "react";
import { MapLoader, MapSkeleton } from "@/components/map/MapLoader";
import { getMapData } from "@/lib/queries";

export const metadata: Metadata = { title: "Map · 2nd Brain" };

export default function MapPage() {
  return (
    <main>
      <Suspense fallback={<MapSkeleton />}>
        <MapData />
      </Suspense>
    </main>
  );
}

async function MapData() {
  const { nodes, edges } = await getMapData();
  return <MapLoader nodes={nodes} edges={edges} />;
}
