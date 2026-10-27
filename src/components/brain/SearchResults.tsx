"use client";

import type { BrainModel, BrainNode } from "@/lib/brain-model";
import type { BrainSearchResult } from "@/lib/queries";

type Props = {
  results: BrainSearchResult;
  model: BrainModel;
  nodeById: Map<string, BrainNode>;
  searchingMeaning: boolean;
  onOpen: (id: string) => void;
  onCapture: () => void;
};

// Readable results: full captions grouped by region, so search answers
// "what do I know about X?" instead of just lighting dots.
export function SearchResults({ results, model, nodeById, searchingMeaning, onOpen, onCapture }: Props) {
  const hits = results.hits.filter((h) => nodeById.has(h.id));

  const groups: { key: string; name: string; color: string; hits: typeof hits }[] = [];
  for (const hit of hits) {
    const node = nodeById.get(hit.id)!;
    const key = node.region == null ? "none" : String(node.region);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      const region = node.region == null ? null : model.regions[node.region];
      group = { key, name: region?.name ?? "Unsorted", color: region?.color ?? node.color, hits: [] };
      groups.push(group);
    }
    group.hits.push(hit);
  }

  const regionNames = groups.filter((g) => g.key !== "none").map((g) => g.name);

  return (
    <div className="brain-fade-in mx-auto mb-2 max-h-[38dvh] max-w-xl overflow-y-auto rounded-3xl border border-border bg-surface p-3 backdrop-blur-xl md:max-h-[45vh]">
      {hits.length ? (
        <>
          <p className="px-2 pb-2 text-xs text-muted">
            <b className="text-text">
              {hits.length} thought{hits.length === 1 ? "" : "s"}
            </b>{" "}
            about &ldquo;{results.query}&rdquo;
            {regionNames.length > 0 && <> · {regionNames.slice(0, 3).join(", ")}</>}
          </p>
          {groups.map((g) => (
            <div key={g.key} className="mb-1">
              <p className="flex items-center gap-2 px-2 pt-1 text-[11px] uppercase tracking-wide" style={{ color: g.color }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: g.color }} />
                {g.name}
              </p>
              <ul>
                {g.hits.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => onOpen(h.id)}
                      className="flex w-full items-start gap-2 rounded-xl px-2 py-2.5 text-left text-sm leading-snug hover:bg-surface-2"
                    >
                      <span className="line-clamp-2 flex-1">{nodeById.get(h.id)!.caption}</span>
                      {h.byMeaning && (
                        <span
                          title="No shared words. Matched by meaning."
                          className="mt-0.5 shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent"
                        >
                          by meaning
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : (
        <div className="flex items-center justify-between gap-3 px-2 py-1">
          <p className="text-sm text-muted">Nothing fires for &ldquo;{results.query}&rdquo; yet.</p>
          <button onClick={onCapture} className="shrink-0 rounded-full bg-accent-soft px-3 py-1.5 text-xs text-accent">
            Log it ＋
          </button>
        </div>
      )}
      {searchingMeaning && <p className="px-2 pt-1 text-[11px] text-muted">Looking for related ideas…</p>}
      {!searchingMeaning && results.semanticUnavailable && (
        <p className="px-2 pt-1 text-[11px] text-muted">Matching words only right now. Search by meaning is resting; try again in a minute.</p>
      )}
    </div>
  );
}
