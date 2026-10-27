import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// /api/capture authenticates with its own token (iOS Shortcuts have no session).
const PUBLIC_PATHS = ["/login", "/api/cron", "/api/capture"];

// Refreshes the Supabase session on every request and gates the app behind login.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          Object.entries(headers).forEach(([key, value]) =>
            response.headers.set(key, value),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Come back to where you were going (e.g. /capture?text=… from a Shortcut).
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    // Already signed in: go where the link was headed (same-site only).
    const next = request.nextUrl.searchParams.get("next");
    let target = new URL("/", request.url);
    if (next?.startsWith("/")) {
      const candidate = new URL(next, request.url);
      if (candidate.origin === target.origin) target = candidate;
    }
    return NextResponse.redirect(target);
  }

  return response;
}

export const config = {
  matcher: [
    // Skip static assets, icons and the manifest.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon|apple-icon|pwa-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
