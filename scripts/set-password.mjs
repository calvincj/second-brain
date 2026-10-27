// Reset the app login password (single-user app, so there's no reset email flow).
//   npm run set-password
// Reads Supabase keys from .env.local and prompts for the new password with
// hidden input, so it never lands in shell history.
import fs from "node:fs";
import readline from "node:readline";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SECRET_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

function ask(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : "");
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    }),
  );
}

const { users } = await (await fetch(`${url}/auth/v1/admin/users`, { headers })).json();
if (!users?.length) {
  console.error("No users found. Create one in Supabase → Authentication → Users.");
  process.exit(1);
}
const user = users.length === 1 ? users[0] : users.find((u) => u.email === process.argv[2]);
if (!user) {
  console.error(`Several users exist; pass the email: npm run set-password -- you@example.com`);
  process.exit(1);
}

console.log(`Setting a new password for ${user.email}`);
const password = await ask("New password (min 8 chars): ", true);
const again = await ask("Repeat it: ", true);
if (password !== again) {
  console.error("Passwords don't match.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Too short.");
  process.exit(1);
}

const res = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ password }),
});
console.log(res.ok ? "Done. Sign in with the new password." : `Failed: ${res.status} ${await res.text()}`);
