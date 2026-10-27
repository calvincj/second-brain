// End-to-end smoke test against a LOCAL Supabase (never your real project).
//
//   npx supabase start        # Docker must be running
//   npx supabase db reset     # fresh schema
//   npm run test:e2e
//
// Starts `next dev` on :3100 pointed at local Supabase with mock embeddings,
// then drives the app in headless Chromium. Screenshots go to e2e/out/.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const APP = "http://localhost:3100";
// Keys of the running LOCAL stack, read from the Supabase CLI (never hardcoded).
const local = Object.fromEntries(
  execSync("npx supabase status -o env", { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const SB = local.API_URL;
const PUBLISHABLE = local.PUBLISHABLE_KEY;
const SECRET = local.SECRET_KEY;
if (!SB?.startsWith("http://127.0.0.1")) throw new Error("Local Supabase isn't running: npx supabase start");
const CRON_SECRET = "e2e-cron-secret";
const EMAIL = "tester@example.com";
const PASSWORD = "correct-horse-42";
const OUT = new URL("./out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
}
const admin = (path, init = {}) =>
  fetch(`${SB}${path}`, {
    ...init,
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });

// --- start the app ------------------------------------------------------------
const server = spawn("npx", ["next", "dev", "-p", "3100"], {
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: SB,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    SUPABASE_SECRET_KEY: SECRET,
    VOYAGE_API_KEY: "", // mock embeddings
    CRON_SECRET,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(APP + "/login")).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

let browser;
try {
  // --- user -------------------------------------------------------------------
  const existing = await (await admin("/auth/v1/admin/users")).json();
  for (const u of existing.users ?? []) await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  const created = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  });
  check("create user via admin API", created.ok);
  const signup = await fetch(`${SB}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "stranger@example.com", password: "whatever-123456" }),
  });
  check("strangers cannot sign up", !signup.ok, `status ${signup.status}`);

  browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // --- login ------------------------------------------------------------------
  await page.goto(APP + "/");
  check("unauthenticated / redirects to /login", page.url().endsWith("/login"));
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', "wrong-password");
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector("text=Invalid login credentials", { timeout: 10000 });
  check("wrong password is rejected", true);
  consoleErrors.length = 0; // the rejected login logs an expected 400
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(APP + "/", { timeout: 15000 });
  check("login lands on home", true);

  // --- create logs ------------------------------------------------------------
  async function addLog(caption, { tags, link, image } = {}) {
    await page.fill('textarea[placeholder="What did you learn?"]', caption);
    if (tags || link) {
      const more = page.locator("text=+ Link & tags");
      if (await more.count()) await more.click();
      if (tags) await page.fill('input[placeholder^="Tags"]', tags);
      if (link) await page.fill('input[placeholder^="Source link"]', link);
    }
    if (image) await page.setInputFiles('input[type="file"]', image);
    await page.click('button:has-text("Log it")');
    await page.waitForSelector("p:has-text('Saved')", { timeout: 15000 });
  }
  const iconPng = OUT + "icon.png";
  fs.writeFileSync(iconPng, Buffer.from(await (await fetch(APP + "/pwa-icon/192")).arrayBuffer()));

  const LOGS = [
    ["Octopuses have three hearts and blue copper-based blood", "biology, ocean", "https://example.com"],
    ["Octopus arms contain two-thirds of its neurons", "biology, ocean, neuroscience"],
    ["Squid and octopus are cephalopods that change color via chromatophores", "biology, ocean"],
    ["Sea otters hold hands while sleeping so they don't drift apart", "biology, ocean"],
    ["Whales evolved from land mammals about 50 million years ago", "biology, ocean, evolution"],
    ["The Dunning-Kruger effect: low-skill people overestimate their ability", "psychology, bias"],
    ["Anchoring bias: the first number you hear skews later estimates", "psychology, bias"],
    ["Loss aversion: losses feel about twice as painful as equivalent gains", "psychology, bias, economics"],
    ["Confirmation bias makes people favor information that confirms beliefs", "psychology, bias"],
    ["73% of startups fail due to premature scaling", "startups, economics"],
    ["Compound interest doubles money in 72/rate years (rule of 72)", "economics, finance"],
    ["Inflation erodes purchasing power of cash savings over time", "economics, finance"],
  ];
  for (const [i, [caption, tags, link]] of LOGS.entries()) {
    await addLog(caption, { tags, link, image: i === 0 ? iconPng : undefined });
  }
  check(`created ${LOGS.length} logs (one with image)`, true);
  await page.goto(APP + "/");
  await page.waitForSelector("text=Recent");
  const cards = await page.locator("section div.space-y-2 > a[href^='/log/']").count();
  check("recent list shows all logs", cards === LOGS.length, `${cards} cards`);
  check("thumbnail rendered via signed URL", (await page.locator('a[href^="/log/"] img').count()) >= 1);
  check("no 'unlinked' logs (all embedded)", (await page.locator("text=· unlinked").count()) === 0);
  check("link title fetched in background", await page.locator("text=↗ Example Domain").first().isVisible());

  // --- rediscover + tags ------------------------------------------------------
  const rediscover = page.locator('section[aria-label="Rediscover"]');
  check("rediscover card shown (>= 5 logs)", await rediscover.isVisible());
  const firstPick = await rediscover.locator("a").innerText();
  let changed = false;
  for (let i = 0; i < 4 && !changed; i++) {
    await rediscover.locator("button").click();
    await page.waitForTimeout(600);
    changed = (await rediscover.locator("a").innerText()) !== firstPick;
  }
  check("rediscover shuffles to another log", changed);

  const biasChip = page.locator('nav[aria-label="Filter by tag"] a:has-text("bias")');
  check("tag chips show counts", (await biasChip.innerText()).includes("4"));
  await biasChip.click();
  await page.waitForURL(/tag=bias/);
  await page.waitForSelector("text=4 tagged bias");
  check("tag filter shows only that tag", (await page.locator("section div.space-y-2 > a[href^='/log/']").count()) === 4);
  await page.screenshot({ path: OUT + "01-home-tag.png", fullPage: true });
  await page.locator('nav[aria-label="Filter by tag"] a[aria-current="true"]').click();
  await page.waitForURL(APP + "/");
  await page.screenshot({ path: OUT + "02-home.png", fullPage: true });

  // --- validation + drafts -------------------------------------------------------
  await page.click('button:has-text("Log it")');
  check("empty caption shows an error", await page.locator("text=Write a one-line caption first.").isVisible());
  await page.fill('textarea[placeholder="What did you learn?"]', "unsent draft text");
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(800);
  check("draft survives reload", (await page.inputValue('textarea[placeholder="What did you learn?"]')) === "unsent draft text");
  await page.fill('textarea[placeholder="What did you learn?"]', "");

  // --- search -------------------------------------------------------------------
  async function search(q) {
    await page.fill('input[type="search"]', q);
    await page.waitForSelector(`text=for "${q}"`, { timeout: 10000 });
    return page.locator("section div.space-y-2 > a[href^='/log/']").allInnerTexts();
  }
  let r = await search("octopus");
  check("search 'octopus' finds octopus logs first", r.length >= 2 && /octopus/i.test(r[0]), `${r.length} results`);
  r = await search("octo");
  check("partial word 'octo' matches", r.some((t) => /octopus/i.test(t)));
  r = await search("cognitive bias");
  check("multi-word query matches any term", r.length >= 4 && r.slice(0, 4).every((t) => /bias/i.test(t)));
  await search("zzzqqq");
  check("nonsense query shows empty state", await page.locator("text=Nothing matches that yet.").isVisible());

  // --- detail, edit, delete ---------------------------------------------------------
  await page.goto(APP + "/");
  await page.locator("section div.space-y-2 > a:has-text('Octopuses have three hearts')").click();
  await page.waitForURL(/\/log\//);
  await page.waitForSelector("text=Related");
  await page.waitForTimeout(800);
  const related = await page.locator('section a[href^="/log/"]').allInnerTexts();
  check("detail shows related logs", related.length > 0, `${related.length} related`);
  check("detail shows full image", (await page.locator("article img").count()) === 1);
  check("detail shows link title + domain", await page.locator("text=Example Domain · example.com").isVisible());
  await page.screenshot({ path: OUT + "03-detail.png", fullPage: true });

  await page.click('button:has-text("Edit")');
  await page.fill("textarea", "Octopuses have three hearts, blue blood, and nine brains");
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=nine brains", { timeout: 10000 });
  check("edit updates caption", true);

  await page.goto(APP + "/");
  await page.locator("section div.space-y-2 > a:has-text('Inflation erodes')").click();
  await page.waitForURL(/\/log\//);
  page.once("dialog", (d) => d.accept());
  await page.click('button:has-text("Delete")');
  await page.waitForURL(APP + "/", { timeout: 10000 });
  let stale = 1;
  for (let t = 0; stale && t < 50; t++) {
    stale = await page.locator("section div.space-y-2 > a:has-text('Inflation erodes')").filter({ visible: true }).count();
    if (stale) await page.waitForTimeout(100);
  }
  check("delete removes log", stale === 0);

  // --- export -------------------------------------------------------------------------
  const exported = await page.evaluate(async () => (await fetch("/api/export")).json());
  check("export JSON has all logs", exported.logs.length === LOGS.length - 1, `${exported.logs.length}`);
  const md = await page.evaluate(async () => (await fetch("/api/export?format=md")).text());
  check("export Markdown works", md.startsWith("# 2nd Brain export") && md.includes("nine brains"));

  // --- cron ---------------------------------------------------------------------------
  check("cron rejects missing secret", (await fetch(APP + "/api/cron")).status === 401);
  const cron = await (await fetch(APP + "/api/cron", { headers: { Authorization: `Bearer ${CRON_SECRET}` } })).json();
  check("cron rebuilds neighbours", cron.neighborsRebuilt === LOGS.length - 1 && !cron.rebuildError, JSON.stringify(cron));
  await admin(`/rest/v1/logs?id=eq.${exported.logs[1].id}`, { method: "PATCH", body: JSON.stringify({ embedding: null, embedding_model: null }) });
  const cron2 = await (await fetch(APP + "/api/cron", { headers: { Authorization: `Bearer ${CRON_SECRET}` } })).json();
  check("cron backfills an unembedded log", cron2.pending === 1 && cron2.embedded === 1, JSON.stringify(cron2));

  // --- map ------------------------------------------------------------------------------
  const before = await (await admin("/rest/v1/logs?select=id&x=is.null")).json();
  await page.goto(APP + "/map");
  await page.waitForSelector("canvas", { timeout: 15000 });
  check("map renders sigma canvas", true);
  check("cold-start hint shown (<50 logs)", await page.locator("text=Clusters get interesting").isVisible());
  await page.waitForSelector("text=Arranging…", { timeout: 5000 }).catch(() => {});
  await page.waitForSelector("text=Arranging…", { state: "detached", timeout: 20000 });
  await page.waitForTimeout(800);
  const after = await (await admin("/rest/v1/logs?select=id&x=is.null")).json();
  check("auto layout saved positions", before.length > 0 && after.length === 0, `${before.length} unplaced → ${after.length}`);
  check("no layout save error", (await page.locator("text=Layout not saved").count()) === 0);
  await page.screenshot({ path: OUT + "04-map.png" });

  await page.fill('input[placeholder="Search the map…"]', "cognitive bias");
  await page.press('input[placeholder="Search the map…"]', "Enter");
  await page.waitForSelector("text=for “cognitive bias”", { timeout: 10000 });
  await page.waitForTimeout(1200);
  check("map search shows matches + bottom sheet", await page.locator("text=Open log →").isVisible());
  await page.screenshot({ path: OUT + "05-map-search.png" });

  const pos1 = await (await admin("/rest/v1/logs?select=id,x,y&order=id")).json();
  await page.reload();
  await page.waitForSelector("canvas");
  await page.waitForTimeout(1500);
  const pos2 = await (await admin("/rest/v1/logs?select=id,x,y&order=id")).json();
  check("reopening map keeps layout stable", (await page.locator("text=Arranging…").count()) === 0 && JSON.stringify(pos1) === JSON.stringify(pos2));

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.fill('input[placeholder="Search the map…"]', "ocean");
  await page.press('input[placeholder="Search the map…"]', "Enter");
  await page.waitForSelector("text=for “ocean”", { timeout: 10000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + "06-map-desktop.png" });

  // --- sign out -------------------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(APP + "/");
  await page.click("text=Sign out");
  await page.waitForURL(/\/login/);
  await page.goto(APP + "/map");
  check("after sign out, /map redirects to login", page.url().endsWith("/login"));

  const errors = consoleErrors.filter((e) => !/React DevTools|favicon/.test(e));
  check("no browser console errors", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 300));
} catch (err) {
  check("test run crashed", false, String(err).split("\n")[0]);
  console.log(serverLog.join("").split("\n").slice(-30).join("\n"));
} finally {
  await browser?.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
