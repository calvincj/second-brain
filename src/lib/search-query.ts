// Turn how people actually type into what's worth searching for:
// "what do I know about octopuses?" → "octopuses".
const QUESTION_PREFIXES = [
  /^what (?:do|did) i (?:know|learn|log|save|write|note)(?: down)? (?:about|on|regarding)\s+/,
  /^(?:anything|everything|stuff|things|facts|notes) (?:about|on|regarding)\s+/,
  /^(?:tell me|remind me|show me)(?: about| of)?\s+/,
  /^(?:what|who|where|when|why|how)(?: (?:is|are|was|were|do|does|did|can|many|much|long|big|old|fast))?\s+/,
  /^(?:is|are|do|does|did|can)\s+/,
];

const FILLER = /^(?:the|a|an|my|some)\s+/;

export function cleanQuery(raw: string): string {
  let q = raw.trim().toLowerCase().replace(/[?!.]+$/, "").trim();
  for (const pattern of QUESTION_PREFIXES) {
    const next = q.replace(pattern, "");
    if (next !== q && next.length >= 2) {
      q = next;
      break;
    }
  }
  q = q.replace(FILLER, "").trim();
  // Never strip a query down to nothing useful.
  return q.length >= 2 ? q : raw.trim();
}
