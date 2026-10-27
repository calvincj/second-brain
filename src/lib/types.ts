export type Log = {
  id: string;
  caption: string;
  tags: string[];
  source_url: string | null;
  source_title: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
  embedding_model: string | null;
};

// Columns to select for a Log (never pull the 1024-float embedding to the UI).
export const LOG_COLUMNS =
  "id, caption, tags, source_url, source_title, image_path, created_at, updated_at, embedding_model";

export const IMAGE_BUCKET = "log-images";

export type MapNode = {
  id: string;
  caption: string;
  tags: string[];
  x: number | null;
  y: number | null;
  embedded: boolean;
};

export type MapEdge = { source: string; target: string; similarity: number };
