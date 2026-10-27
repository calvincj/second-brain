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
  await page.click('button:has-text("Delete")');
  await page.waitForURL(/\/list\?deleted=/, { timeout: 10000 });
  check("list offers Undo after deleting from a log page", !!(await page.waitForSelector("text=Thought deleted.", { timeout: 10000 }).catch(() => null)));
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
  await page.click('button[aria-label="Menu"]');
  check("menu shows thought count", await page.locator(`text=${COUNT} thoughts`).isVisible().catch(() => false) || (await page.locator("p:has-text('thoughts ·')").innerText()).startsWith(String(COUNT)));
  await page.click('button[aria-label="Menu"]');
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
  // Saved right after the positions it describes.
  let settings = [];
  for (let t = 0; t < 20 && !settings[0]?.layout_version; t++) {
    settings = await (await admin("/rest/v1/brain_settings?select=layout_version")).json();
    if (!settings[0]?.layout_version) await page.waitForTimeout(500);
  }
  check("layout version saved for all devices", settings[0]?.layout_version?.length > 0, JSON.stringify(settings));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + "01-brain.png" });

  await page.fill(brainInput, "cognitive bias");
  const panel = page.locator("text=thoughts about").locator("xpath=ancestor::div[contains(@class,'rounded-3xl')][1]");
  await page.waitForSelector("text=thoughts about", { timeout: 15000 });
  const hitChips = panel.locator("li button");
  check("brain search shows readable results", (await hitChips.count()) >= 4, `${await hitChips.count()} hits`);
  check("results show full captions", await panel.locator("text=Confirmation bias makes people favor information that confirms beliefs").isVisible());
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT + "02-brain-search.png" });
  await hitChips.first().click();
  await page.waitForSelector("text=Connected thoughts", { timeout: 5000 }).catch(() => {});
  check("tapping a hit opens the thought card", await page.locator("aside >> text=Full page").isVisible());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + "03-brain-thought.png" });
  await page.locator('aside button[aria-label="Close"]').click();
  await page.locator('button[aria-label="Clear search"]').click();

  await page.fill(brainInput, "octopis");
  await page.waitForSelector("text=about “octopis”", { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('text=thoughts about', { timeout: 10000 });
  check("typos still find thoughts (octopis)", await page.locator("li button:has-text('Octopus')").first().isVisible());
  await page.fill(brainInput, "what do I know about octopus?");
  await page.waitForSelector('text=about "octopus"', { timeout: 10000 }).catch(() => {});
  check("questions are understood", await page.locator("text=octopus”").first().isVisible().catch(() => false) || (await page.locator("li button:has-text('Octopus')").count()) > 0);
  await page.locator('button[aria-label="Clear search"]').click();
  await page.click(brainInput);
  check("recent searches appear on focus", await page.locator("text=Recent").first().isVisible());
  await page.locator(brainInput).blur();

  await regionChips.first().click();
  await page.waitForSelector("text=thoughts in this region");
  check("tapping a region opens its card", true);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + "04-brain-region.png" });
  await page.locator('aside button[aria-label="Close"]').click();

  // A new thought is born in the brain.
  // No tags on purpose: its neighbours' shared tags should be suggested.
  await page.fill(brainInput, "Octopus arms contain taste receptors in their suckers");
  await page.click('button[aria-label="Log a new thought"]');
  await page.click('button:has-text("Log it")');
  const toast = await page.waitForSelector('[role="status"]', { timeout: 10000 });
  const toastText = await toast.innerText();
  check("birth toast says what it connected to", /Connected to:/.test(toastText), toastText.slice(0, 80));
  const suggestion = page.locator('[role="status"] button').first();
  const suggestedTag = (await suggestion.count()) ? (await suggestion.innerText()).replace("+", "").trim() : null;
  check("toast suggests tags from neighbours", !!suggestedTag, suggestedTag ?? "none");
  if (suggestedTag) {
    await suggestion.click();
    await page.waitForTimeout(1500);
  }
  await page.click('button[aria-label="Menu"]');
  check("thought count goes up without reload", (await page.locator("p:has-text('thoughts ·')").innerText()).startsWith(String(COUNT + 1)));
  await page.click('button[aria-label="Menu"]');
  await page.waitForTimeout(3500);
  check("new thought's card opens after it settles", await page.locator("aside >> text=taste receptors in their suckers").isVisible());
  await page.screenshot({ path: OUT + "05-brain-birth.png" });
  if (suggestedTag) {
    const born = await (await admin(`/rest/v1/logs?select=tags&caption=eq.${encodeURIComponent("Octopus arms contain taste receptors in their suckers")}`)).json();
    check("tapping a suggestion adds the tag", born[0]?.tags.includes(suggestedTag), JSON.stringify(born[0]?.tags));
  }
  const newPlaced = await (await admin("/rest/v1/logs?select=id&z=not.is.null")).json();
  check("new thought's position saved", newPlaced.length === COUNT + 1, `${newPlaced.length}`);

  // Edit in place: the card is still open on the newborn thought.
  await page.locator('aside button:has-text("Edit")').click();
  await page.fill("aside textarea", "Octopus arms contain taste receptors in their suckers, and edits work");
  await page.locator('aside button:has-text("Save")').click();
  await page.waitForSelector("aside >> text=Edit thought", { state: "detached", timeout: 15000 });
  await page.waitForSelector("aside >> text=edits work", { timeout: 15000 });
  check("edit in the brain updates the card", true);
  const edited = await (await admin(`/rest/v1/logs?select=id&caption=ilike.${encodeURIComponent("*edits work*")}`)).json();
  check("edit saved to the database", edited.length === 1);
  const editedTags = await (await admin(`/rest/v1/logs?select=tags&caption=ilike.${encodeURIComponent("*edits work*")}`)).json();
  check("editing keeps a tag accepted moments earlier", !suggestedTag || editedTags[0]?.tags.includes(suggestedTag), JSON.stringify(editedTags[0]?.tags));

  // Delete with undo: the neuron goes, Undo brings it back, nothing is deleted.
  await page.locator('aside button:has-text("Delete")').click();
  await page.waitForSelector('[role="status"] >> text=Thought deleted', { timeout: 5000 });
  await page.click('button[aria-label="Menu"]');
  const afterDelete = (await page.locator("p:has-text('thoughts ·')").innerText()).split(" ")[0];
  await page.click('button[aria-label="Menu"]');
  await page.locator('[role="status"] button:has-text("Undo")').click();
  await page.waitForSelector('[role="status"] >> text=Restored', { timeout: 8000 });
  const stillThere = await (await admin(`/rest/v1/logs?select=deleted_at&id=eq.${edited[0].id}`)).json();
  check("delete hides the neuron, undo restores it", afterDelete === String(COUNT) && stillThere[0]?.deleted_at === null, `count after delete ${afterDelete}`);

  // Delete for real.
  await page.locator('nav[aria-label="Thoughts by region"] button:has-text("edits work")').first().evaluate((b) => b.click());
  await page.waitForSelector('aside button:has-text("Delete")');
  await page.locator('aside button:has-text("Delete")').click();
  await page.waitForTimeout(1500);
  const gone = await (await admin(`/rest/v1/logs?select=deleted_at&id=eq.${edited[0].id}`)).json();
  check("delete marks it deleted immediately (survives closing the app)", !!gone[0]?.deleted_at);
  const listNow = await page.evaluate(async () => (await fetch("/api/export")).json());
  check("deleted thoughts vanish from everything (export)", !listNow.logs.some((l) => l.caption.includes("edits work")));
  // Pretend it was deleted 8 days ago: the cron purges it for good.
  await admin(`/rest/v1/logs?id=eq.${edited[0].id}`, { method: "PATCH", body: JSON.stringify({ deleted_at: new Date(Date.now() - 8 * 864e5).toISOString() }) });
  const purge = await (await fetch(APP + "/api/cron", { headers: { Authorization: `Bearer ${CRON_SECRET}` } })).json();
  const purged = await (await admin(`/rest/v1/logs?select=id&id=eq.${edited[0].id}`)).json();
  check("cron purges week-old deletions", purge.purged === 1 && purged.length === 0, JSON.stringify(purge));
  check("hidden accessible list mirrors the brain", (await page.locator('nav[aria-label="Thoughts by region"] li').count()) >= 3);

  // Reopening keeps the layout stable.
  const pos1 = await (await admin("/rest/v1/logs?select=id,x,y,z&order=id")).json();
  await page.reload();
  await page.waitForSelector("canvas");
  await page.waitForTimeout(2500);
  const pos2 = await (await admin("/rest/v1/logs?select=id,x,y,z&order=id")).json();
  check("reopening the brain keeps the layout stable", JSON.stringify(pos1) === JSON.stringify(pos2));

  // A memory stirs: make a few thoughts old and unseen, allow today's stir.
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  await admin(`/rest/v1/logs?id=not.is.null`, { method: "PATCH", body: JSON.stringify({ created_at: old, last_viewed_at: null }) });
  await page.evaluate(() => localStorage.removeItem("brain:stirred"));
  await page.goto(APP + "/");
  const stirred = await page.waitForSelector("text=A memory stirs", { timeout: 25000 }).catch(() => null);
  check("a memory stirs for old, unseen thoughts", !!stirred);
  if (stirred) {
    await page.screenshot({ path: OUT + "06-memory.png" });
    await page.locator('button:has-text("Open")').first().click();
    check("opening the memory shows its card", !!(await page.waitForSelector("aside >> text=Connected thoughts", { timeout: 8000 }).catch(() => null)));
    await page.locator('aside button[aria-label="Close"]').click();
  }
  await page.goto(APP + "/");
  await page.waitForTimeout(5000);
  check("only one stir per day", (await page.locator("text=A memory stirs").count()) === 0);

  // While you were away: a thought arrived (e.g. via a Shortcut) after the last visit.
  await page.evaluate(() => localStorage.setItem("brain:lastVisit", String(Date.now() - 3600_000)));
  const fresh = await (await admin("/rest/v1/logs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ caption: "Arrived while away: honeybees can recognise faces", tags: ["biology"], user_id: (await (await admin("/auth/v1/admin/users")).json()).users[0].id }),
  })).json();
  await page.goto(APP + "/");
  const awayCard = await page.waitForSelector("text=While you were away", { timeout: 25000 }).catch(() => null);
  check("'while you were away' replays new thoughts", !!awayCard && (await page.locator("text=+1").count()) > 0);
  if (awayCard) await page.screenshot({ path: OUT + "07-away.png" });
  await page.locator('button:has-text("Nice")').click().catch(() => {});
  await admin(`/rest/v1/logs?id=eq.${fresh[0].id}`, { method: "DELETE" });

  // Move to region: pin a thought into another region.
  await page.locator('nav[aria-label="Thoughts by region"] button').first().evaluate((b) => b.click());
  await page.waitForSelector("aside select", { timeout: 10000 });
  const select = page.locator("aside select");
  const current = await select.inputValue();
  const options = await select.locator("option").evaluateAll((os) => os.map((o) => o.value));
  const targetRegion = options.find((v) => v !== current && v !== "");
  if (targetRegion != null) {
    await select.selectOption(targetRegion);
    const moved = await page.waitForSelector('[role="status"] >> text=Moved to', { timeout: 8000 }).catch(() => null);
    const pinned = await (await admin("/rest/v1/logs?select=id&region_anchor=not.is.null")).json();
    check("move to region saves a pin", !!moved && pinned.length === 1, `${pinned.length} pinned`);
  } else {
    check("move to region saves a pin", false, "only one region");
  }
  await page.locator('aside button[aria-label="Close"]').click();

  // Bottom sheet: drag the handle down to dismiss.
  await regionChips.first().click();
  await page.waitForSelector("text=thoughts in this region");
  const handle = page.locator("aside > div[aria-hidden]").first();
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForTimeout(600);
  check("dragging the sheet down dismisses it", (await page.locator("text=thoughts in this region").count()) === 0);

  await page.goto(APP + "/?capture=1");
  await page.waitForSelector("text=New thought", { timeout: 20000 });
  check("/?capture=1 opens straight into logging", true);
  await page.locator('aside button[aria-label="Close"]').click();

  // --- fast capture ------------------------------------------------------------------------------
  await page.goto(APP + "/capture?text=" + encodeURIComponent("Shared from Safari: honey never spoils") + "&url=" + encodeURIComponent("https://example.com"));
  await page.waitForSelector('textarea[placeholder="What did you learn?"]', { timeout: 30000 });
  await page.waitForTimeout(500);
  check("/capture prefills text and link", (await page.inputValue("textarea")) === "Shared from Safari: honey never spoils" && (await page.inputValue('input[placeholder^="Source link"]')).includes("example.com"));
  await page.click('button:has-text("Log it")');
  check("/capture saves and confirms", !!(await page.waitForSelector("text=✦ Saved.", { timeout: 15000 }).catch(() => null)));

  await page.goto(APP + "/");
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.click('button[aria-label="Menu"]');
  await page.click("text=iPhone Shortcut…");
  await page.click("text=Create my personal token");
  const tokenEl = await page.waitForSelector("aside code", { timeout: 10000 }).catch(() => null);
  const token = tokenEl ? (await tokenEl.innerText()).trim() : "";
  check("Shortcut sheet creates a token", token.length >= 32);
  await page.locator('aside button[aria-label="Close"]').click();
  const bad = await fetch(APP + "/api/capture", { method: "POST", headers: { Authorization: "Bearer " + "x".repeat(40), "Content-Type": "application/json" }, body: JSON.stringify({ text: "nope" }) });
  check("capture API rejects a bad token", bad.status === 401);
  const good = await fetch(APP + "/api/capture", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Logged by Siri: octopus arms can taste", tags: "biology" }),
  });
  const goodJson = await good.json();
  check("capture API logs a thought with a token", good.ok && goodJson.ok, JSON.stringify(goodJson));
  await page.waitForTimeout(2500);
  const viaApi = await (await admin(`/rest/v1/logs?select=embedding_model,tags&id=eq.${goodJson.id}`)).json();
  check("API-captured thought gets connected", !!viaApi[0]?.embedding_model && viaApi[0]?.tags.includes("biology"), JSON.stringify(viaApi));
  const listTags = await (await fetch(APP + "/api/capture", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Tags as a list from Shortcuts", tags: ["alpha", "beta"] }),
  })).json();
  const listRow = await (await admin(`/rest/v1/logs?select=tags&id=eq.${listTags.id}`)).json();
  check("capture API accepts tags as a list", JSON.stringify(listRow[0]?.tags) === '["alpha","beta"]', JSON.stringify(listRow));
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await fetch(APP + "/api/capture", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: `flood ${i}` }) });
    limited = r.status === 429;
  }
  check("capture API rate-limits a flood", limited);
  await admin(`/rest/v1/logs?caption=like.flood*`, { method: "DELETE" });

  // --- menu + sign out ------------------------------------------------------------------------
  await page.click('button[aria-label="Menu"]');
  check("menu links to list view", await page.locator('a[href="/list"]').isVisible());
  await page.click("text=Sign out");
  await page.waitForURL(/\/login/);
  await page.goto(APP + "/");
  check("after sign out, / redirects to login", page.url().endsWith("/login"));
  // A Shortcut opening /capture while signed out: log in, land back on it, text intact.
  await page.goto(APP + "/capture?text=" + encodeURIComponent("Kept through login"));
  await page.waitForURL(/\/login\?next=/);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/capture/, { timeout: 20000 });
  await page.waitForSelector("textarea", { timeout: 20000 });
  await page.waitForTimeout(500);
  check("login returns to /capture with the shared text", (await page.inputValue("textarea")) === "Kept through login");

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
