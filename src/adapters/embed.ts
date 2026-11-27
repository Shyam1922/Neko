// Text -> vector, for finding conversations by meaning ("that chat about laptops" finds one that said
// "notebook"). The rest of the app only knows the Embedder interface, so tests use a fake and the
// provider can be swapped.

import { GoogleGenAI } from "@google/genai";
import { withTimeout } from "./timeout.ts";

/** Stored texts are embedded as documents, searches as queries: retrieval models place the two differently. */
export type EmbedKind = "document" | "query";

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

/** Must match the vector(768) column in the schema. */
export const EMBED_DIMS = 768;
const MAX_CHARS = 8_000; // gemini-embedding-001 reads up to 2,048 tokens; longer text is cut, not refused
const BATCH = 50;
const TIMEOUT_MS = 20_000;

export class GeminiEmbedder implements Embedder {
  readonly dims = EMBED_DIMS;
  private ai: GoogleGenAI;

  constructor(apiKey: string, readonly model = "gemini-embedding-001") {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH).map((t) => t.slice(0, MAX_CHARS) || " ");
      const res = await withTimeout(
        this.ai.models.embedContent({
          model: this.model,
          contents: chunk,
          config: { outputDimensionality: this.dims, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" },
        }),
        TIMEOUT_MS,
        "the embedding model",
      );
      const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
      // One vector per input, each the right length, or the batch is unusable: never store a partial answer.
      if (vectors.length !== chunk.length || vectors.some((v) => v.length !== this.dims)) {
        throw new Error(`The embedding model returned ${vectors.length} vectors for ${chunk.length} texts.`);
      }
      out.push(...vectors);
    }
    return out;
  }
}
