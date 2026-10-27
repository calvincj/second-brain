import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { CaptureView } from "./CaptureView";

export const metadata: Metadata = { title: "New thought · 2nd Brain" };
export const viewport: Viewport = { themeColor: "#04050c" };

export default function CapturePage({ searchParams }: PageProps<"/capture">) {
  return (
    <main className="brain-scope min-h-dvh">
      <Suspense>
        <Capture searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Capture({ searchParams }: Pick<PageProps<"/capture">, "searchParams">) {
  const supabase = await createClient();
  const [{ data }, params] = await Promise.all([supabase.auth.getUser(), searchParams]);
  const pick = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 1000) : "");
  return <CaptureView userId={data.user!.id} text={pick(params.text)} url={pick(params.url)} />;
}
