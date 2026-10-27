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

  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  // `next dev` compiles each route on first visit; give it time.
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(45_000);
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  const brainInput = 'input[aria-label="Search your brain"]';
  const listCards = "section div.space-y-2 > a[href^='/log/']";

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
  await page.waitForSelector("text=Your brain is empty", { timeout: 15000 });
  check("login lands on the (empty) brain", true);

  // --- first thought: typed in the brain bar, logged with ＋ ----------------------
  const iconPng = OUT + "icon.png";
  fs.writeFileSync(iconPng, Buffer.from(await (await fetch(APP + "/pwa-icon/192")).arrayBuffer()));
  await page.fill(brainInput, "Octopuses have three hearts and blue copper-based blood");
  await page.click('button[aria-label="Log a new thought"]');
  await page.waitForSelector("text=New thought");
  await page.waitForTimeout(300);
  check(
    "＋ opens capture prefilled with the typed text",
    (await page.inputValue('textarea[placeholder="What did you learn?"]')) === "Octopuses have three hearts and blue copper-based blood",
  );
  await page.click("text=+ Link & tags");
  await page.fill('input[placeholder^="Tags"]', "biology, ocean");
  await page.fill('input[placeholder^="Source link"]', "https://example.com");
  await page.setInputFiles('input[type="file"]', iconPng);
  await page.click('button:has-text("Log it")');
  await page.waitForSelector("text=New thought", { state: "detached", timeout: 15000 });
  await page.waitForSelector('[role="status"]', { timeout: 10000 });
  check("saving closes the sheet and shows a toast", true);

  // --- the rest via the list view --------------------------------------------------
  async function addLog(caption, { tags } = {}) {
    await page.fill('textarea[placeholder="What did you learn?"]', caption);
    if (tags) {
      const more = page.locator("text=+ Link & tags");
      if (await more.count()) await more.click();
      await page.fill('input[placeholder^="Tags"]', tags);
    }
    await page.click('button:has-text("Log it")');
    await page.waitForSelector("p:has-text('Saved')", { timeout: 15000 });
  }
  const LOGS = [
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
  await page.goto(APP + "/list");
  for (const [caption, tags] of LOGS) await addLog(caption, { tags });
  const TOTAL = LOGS.length + 1;
  await page.goto(APP + "/list");
  await page.waitForSelector("text=Recent");
  const visibleCards = () => page.locator(listCards).filter({ visible: true });
  check("list shows all logs", (await visibleCards().count()) === TOTAL, `${await visibleCards().count()}`);
  check("thumbnail rendered via signed URL", (await page.locator('a[href^="/log/"] img').count()) >= 1);
  check("no 'unlinked' logs (all embedded)", (await page.locator("text=· unlinked").count()) === 0);
  check("link title fetched in background", await page.locator("text=↗ Example Domain").first().isVisible());
  check("rediscover card is gone", (await page.locator("text=Rediscover").count()) === 0);

  // --- tags, validation, drafts, search (list) --------------------------------------
  const biasChip = page.locator('nav[aria-label="Filter by tag"] a:has-text("bias")');
  check("tag chips show counts", (await biasChip.innerText()).includes("4"));
  await biasChip.click();
  await page.waitForSelector("text=4 tagged bias");
  check("tag filter shows only that tag", (await visibleCards().count()) === 4);
  await page.goto(APP + "/list");
  await page.click('button:has-text("Log it")');
  check("empty caption shows an error", await page.locator("text=Write a one-line caption first.").isVisible());
  await page.fill('textarea[placeholder="What did you learn?"]', "unsent draft text");
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(800);
  check("draft survives reload", (await page.inputValue('textarea[placeholder="What did you learn?"]')) === "unsent draft text");
  await page.fill('textarea[placeholder="What did you learn?"]', "");
  async function listSearch(q) {
    await page.fill('input[type="search"]', q);
    await page.waitForSelector(`text=for "${q}"`, { timeout: 10000 });
    return visibleCards().allInnerTexts();
  }
  let r = await listSearch("octopus");
  check("search 'octopus' finds octopus logs first", r.length >= 2 && /octopus/i.test(r[0]));
  r = await listSearch("cognitive bias");
  check("multi-word query matches any term", r.length >= 4 && r.slice(0, 4).every((t) => /bias/i.test(t)));
  await listSearch("zzzqqq");
  check("nonsense query shows empty state", await page.locator("text=Nothing matches that yet.").isVisible());

  // --- detail, edit, delete ------------------------------------------------------------
  await page.goto(APP + "/list");
  await page.locator(`${listCards}:has-text('Octopuses have three hearts')`).filter({ visible: true }).first().click();
  await page.waitForURL(/\/log\//);
  await page.waitForSelector("text=Related");
  check("detail shows full image + link title", (await page.locator("article img").count()) === 1 && (await page.locator("text=Example Domain · example.com").isVisible()));
  await page.click('button:has-text("Edit")');
  await page.fill("textarea", "Octopuses have three hearts, blue blood, and nine brains");
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=nine brains", { timeout: 10000 });
  check("edit updates caption", true);
  await page.goto(APP + "/list");
  await page.locator(`${listCards}:has-text('Inflation erodes')`).filter({ visible: true }).first().click();
  await page.waitForURL(/\/log\//);
  page.once("dialog", (d) => d.accept());
  await page.click('button:has-text("Delete")');
  await page.waitForURL(APP + "/list", { timeout: 10000 });
  let stale = 1;
  for (let t = 0; stale && t < 50; t++) {
    stale = await page.locator(`${listCards}:has-text('Inflation erodes')`).filter({ visible: true }).count();
    if (stale) await page.waitForTimeout(100);
  }
  check("delete removes log and returns to list", stale === 0);
  const COUNT = TOTAL - 1;

  // --- export + cron -------------------------------------------------------------------
  const exported = await page.evaluate(async () => (await fetch("/api/export")).json());
  check("export JSON has all logs", exported.logs.length === COUNT, `${exported.logs.length}`);
  check("cron rejects missing secret", (await fetch(APP + "/api/cron")).status === 401);
  await admin(`/rest/v1/logs?id=eq.${exported.logs[1].id}`, { method: "PATCH", body: JSON.stringify({ embedding: null, embedding_model: null }) });
  const cron = await (await fetch(APP + "/api/cron", { headers: { Authorization: `Bearer ${CRON_SECRET}` } })).json();
  check("cron backfills + rebuilds neighbours", cron.pending === 1 && cron.embedded === 1 && cron.neighborsRebuilt === COUNT, JSON.stringify(cron));

  // --- the brain ---------------------------------------------------------------------------
  await page.goto(APP + "/");
  await page.waitForSelector("canvas", { timeout: 20000 });
  check("brain renders a WebGL canvas", true);
  check("stats show thought count", (await page.locator(`text=${COUNT}`).first().isVisible()));
  const regionChips = page.locator('nav[aria-label="Regions"] button');
  await page.waitForTimeout(500);
  check("regions formed", (await regionChips.count()) >= 2, `${await regionChips.count()} regions`);
  let placed = [];
  for (let t = 0; t < 30; t++) {
    placed = await (await admin("/rest/v1/logs?select=id&z=not.is.null")).json();
    if (placed.length === COUNT) break;
    await page.waitForTimeout(500);
  }
  check("3D layout saved positions", placed.length === COUNT, `${placed.length}/${COUNT}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + "01-brain.png" });

  await page.fill(brainInput, "cognitive bias");
  await page.waitForTimeout(2500);
  const hitChips = page.locator(`form:has(${brainInput})`).locator("xpath=..").locator("button:has(span.truncate)");
  check("brain search lights up hits", (await hitChips.count()) >= 4, `${await hitChips.count()} hits`);
  await page.screenshot({ path: OUT + "02-brain-search.png" });
  await hitChips.first().click();
  await page.waitForSelector("text=Connected thoughts", { timeout: 5000 }).catch(() => {});
  check("tapping a hit opens the thought card", await page.locator("text=Open, edit or delete").isVisible());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + "03-brain-thought.png" });
  await page.locator('aside button[aria-label="Close"]').click();
  await page.locator('button[aria-label="Clear search"]').click();

  await regionChips.first().click();
  await page.waitForSelector("text=thoughts in this region");
  check("tapping a region opens its card", true);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + "04-brain-region.png" });
  await page.locator('aside button[aria-label="Close"]').click();

  // A new thought is born in the brain.
  await page.fill(brainInput, "Octopuses can taste with their suckers");
  await page.click('button[aria-label="Log a new thought"]');
  await page.click("text=+ Link & tags");
  await page.fill('input[placeholder^="Tags"]', "biology, ocean");
  await page.click('button:has-text("Log it")');
  const toast = await page.waitForSelector('[role="status"]', { timeout: 10000 });
  const toastText = await toast.innerText();
  check("birth toast says what it connected to", /Connected to:/.test(toastText), toastText.slice(0, 80));
  await page.waitForSelector(`text=${COUNT + 1}`, { timeout: 5000 });
  check("thought count goes up without reload", true);
  await page.waitForTimeout(3500);
  check("new thought's card opens after it settles", await page.locator("aside >> text=taste with their suckers").isVisible());
  await page.screenshot({ path: OUT + "05-brain-birth.png" });
  const newPlaced = await (await admin("/rest/v1/logs?select=id&z=not.is.null")).json();
  check("new thought's position saved", newPlaced.length === COUNT + 1, `${newPlaced.length}`);

  // Reopening keeps the layout stable.
  const pos1 = await (await admin("/rest/v1/logs?select=id,x,y,z&order=id")).json();
  await page.reload();
  await page.waitForSelector("canvas");
  await page.waitForTimeout(2500);
  const pos2 = await (await admin("/rest/v1/logs?select=id,x,y,z&order=id")).json();
  check("reopening the brain keeps the layout stable", JSON.stringify(pos1) === JSON.stringify(pos2));

  // --- menu + sign out ------------------------------------------------------------------------
  await page.click('button[aria-label="Menu"]');
  check("menu links to list view", await page.locator('a[href="/list"]').isVisible());
  await page.click("text=Sign out");
  await page.waitForURL(/\/login/);
  await page.goto(APP + "/");
  check("after sign out, / redirects to login", page.url().endsWith("/login"));

  const errors = consoleErrors.filter((e) => !/React DevTools|favicon|GPU stall|WebGL/.test(e));
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
