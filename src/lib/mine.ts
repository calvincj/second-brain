// Thoughts logged on this device, so they don't come back as "while you were
// away" (you saw them being made).
export const MINE_KEY = "brain:mine";

export function rememberMine(id: string) {
  try {
    const ids: string[] = JSON.parse(localStorage.getItem(MINE_KEY) ?? "[]");
    localStorage.setItem(MINE_KEY, JSON.stringify([...ids.filter((x) => x !== id), id].slice(-100)));
  } catch {
    // Storage blocked: at worst it shows up as "while you were away".
  }
}

export function readMine(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MINE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
