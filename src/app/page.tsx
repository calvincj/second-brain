import type { Viewport } from "next";
import { Suspense } from "react";
import { BrainExperience } from "@/components/brain/BrainExperience";
import { getMapData } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const viewport: Viewport = { themeColor: "#04050c" };

export default function BrainPage() {
  return (
    <main className="brain-scope fixed inset-0">
      <Suspense fallback={<WakingUp />}>
        <Brain />
      </Suspense>
    </main>
  );
}

function WakingUp() {
  return (
    <div className="flex h-dvh items-center justify-center text-sm text-muted">
      <span className="mr-3 h-3 w-3 animate-ping rounded-full bg-accent" />
      Waking up your brain…
    </div>
  );
}

async function Brain() {
  const supabase = await createClient();
  const [{ data }, { nodes, edges }] = await Promise.all([supabase.auth.getUser(), getMapData()]);
  return <BrainExperience userId={data.user!.id} nodes={nodes} edges={edges} />;
}
