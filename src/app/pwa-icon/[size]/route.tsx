import { brandIcon } from "@/lib/brand-icon";

const SIZES = new Set([192, 512]);

export async function GET(_request: Request, { params }: RouteContext<"/pwa-icon/[size]">) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  return brandIcon(size);
}
