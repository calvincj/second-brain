"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createLog, updateLog, type ActionResult, type LogInput } from "@/app/actions";
import { createClient } from "@/lib/supabase/client";
import { resizeImage } from "@/lib/image";
import { IMAGE_BUCKET } from "@/lib/types";

const DRAFT_KEY = "second-brain:draft";

type Props = {
  userId: string;
  // Present when editing an existing log.
  logId?: string;
  initial?: { caption: string; tags: string[]; sourceUrl: string; imagePath: string | null; imageUrl: string | null };
  // New logs only: start with this caption / link instead of any saved draft.
  prefill?: string;
  prefillUrl?: string;
  autoFocus?: boolean;
  onDone?: () => void;
  onSaved?: (result: Extract<ActionResult, { ok: true }>) => void;
};

function readDraft(): Partial<LogInput> {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function LogForm({ userId, logId, initial, prefill, prefillUrl, autoFocus, onDone, onSaved }: Props) {
  const isEdit = !!logId;
  const [caption, setCaption] = useState(initial?.caption ?? "");
  const [tags, setTags] = useState(initial?.tags.join(", ") ?? "");
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? "");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(initial?.imageUrl ?? null);
  const [keepImagePath, setKeepImagePath] = useState<string | null>(initial?.imagePath ?? null);
  const [showExtras, setShowExtras] = useState(isEdit);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const captionInput = useRef<HTMLTextAreaElement>(null);

  // Restore an unsent draft (new logs only). Done after mount rather than in a
  // lazy initializer so server and client render the same initial HTML.
  useEffect(() => {
    if (isEdit) return;
    const draft = readDraft();
    /* eslint-disable react-hooks/set-state-in-effect */
    if (prefill) setCaption(prefill);
    else if (draft.caption) setCaption(draft.caption);
    if (draft.tags) setTags(draft.tags);
    if (prefillUrl) setSourceUrl(prefillUrl);
    else if (draft.sourceUrl) setSourceUrl(draft.sourceUrl);
    if (draft.tags || draft.sourceUrl || prefillUrl) setShowExtras(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isEdit, prefill, prefillUrl]);

  // Autosave the draft so a flaky connection never loses typing.
  useEffect(() => {
    if (isEdit) return;
    try {
      if (caption || tags || sourceUrl) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ caption, tags, sourceUrl }));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      // Storage unavailable (private mode); drafts just won't persist.
    }
  }, [isEdit, caption, tags, sourceUrl]);

  function pickImage(file: File | undefined) {
    if (!file) return;
    setImageFile(file);
    setKeepImagePath(null);
    setImagePreview(URL.createObjectURL(file));
    setShowExtras(true);
  }

  function removeImage() {
    setImageFile(null);
    setKeepImagePath(null);
    setImagePreview(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function uploadImage(): Promise<string | null> {
    if (!imageFile) return keepImagePath;
    const blob = await resizeImage(imageFile);
    const path = `${userId}/${crypto.randomUUID()}.jpg`;
    const { error } = await createClient()
      .storage.from(IMAGE_BUCKET)
      .upload(path, blob, { contentType: "image/jpeg" });
    if (error) throw new Error(`Image upload failed: ${error.message}`);
    return path;
  }

  function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!caption.trim()) {
      setMessage({ kind: "error", text: "Write a one-line caption first." });
      captionInput.current?.focus();
      return;
    }
    setMessage(null);
    startTransition(async () => {
      try {
        const imagePath = await uploadImage();
        const input = { caption, tags, sourceUrl, imagePath };
        const result = isEdit ? await updateLog(logId, input) : await createLog(input);
        if (!result.ok) {
          // Don't leave a freshly uploaded image orphaned in storage.
          if (imagePath && imagePath !== keepImagePath) {
            await createClient().storage.from(IMAGE_BUCKET).remove([imagePath]);
          }
          setMessage({ kind: "error", text: result.error });
          return;
        }
        if (!isEdit) {
          setCaption("");
          setTags("");
          setSourceUrl("");
          removeImage();
          setShowExtras(false);
        }
        setMessage({
          kind: "ok",
          text: result.embedded ? "Saved." : "Saved. It'll be linked to related logs shortly.",
        });
        onSaved?.(result);
        onDone?.();
      } catch (err) {
        setMessage({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong." });
      }
    });
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-border bg-surface p-3 shadow-sm">
      <textarea
        ref={captionInput}
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
        placeholder="What did you learn?"
        autoFocus={autoFocus}
        rows={2}
        maxLength={1000}
        className="w-full resize-none bg-transparent px-1 py-1 outline-none placeholder:text-muted"
      />

      {showExtras && (
        <div className="mt-2 space-y-2">
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags, comma separated (optional)"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 outline-none focus:border-accent"
          />
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="Source link (optional)"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 outline-none focus:border-accent"
          />
        </div>
      )}

      {imagePreview && (
        <div className="relative mt-2 inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imagePreview} alt="" className="max-h-40 rounded-lg border border-border" />
          <button
            type="button"
            onClick={removeImage}
            aria-label="Remove image"
            className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-text text-bg text-sm"
          >
            ×
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => pickImage(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="h-11 rounded-lg px-3 text-sm text-muted hover:bg-surface-2"
        >
          📷 Image
        </button>
        {!showExtras && (
          <button
            type="button"
            onClick={() => setShowExtras(true)}
            className="h-11 rounded-lg px-3 text-sm text-muted hover:bg-surface-2"
          >
            + Link & tags
          </button>
        )}
        <div className="flex-1" />
        {isEdit && (
          <button type="button" onClick={onDone} className="h-11 rounded-lg px-4 text-sm text-muted">
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={pending}
          className="h-11 rounded-lg bg-accent px-5 text-sm font-medium text-on-accent disabled:opacity-60"
        >
          {pending ? "Saving…" : isEdit ? "Save" : "Log it"}
        </button>
      </div>

      {message && (
        <p className={`mt-2 px-1 text-sm ${message.kind === "error" ? "text-danger" : "text-muted"}`}>
          {message.text}
        </p>
      )}
    </form>
  );
}
