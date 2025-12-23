// supabase/functions/ai-generate-plan/shared.ts
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type GeneratePlanBody = {
  mode: "generate_plan";
  person_name?: string;
  user_id?: string;
  company_name: string;
  company_title: string;
  short_description: string;
  long_description?: string | null;
};

export type DeepDiveBody = {
  mode: "deep_dive";
  plan_id: string;
  step_key: string;
};
export type DeepDiveStreamBody = Omit<DeepDiveBody, "mode"> & { mode: "deep_dive_stream" };

export type Body =
  | GeneratePlanBody
  | DeepDiveBody
  | (Omit<GeneratePlanBody, "mode"> & { mode: "generate_plan_stream" })
  | (Omit<DeepDiveBody, "mode"> & { mode: "deep_dive_stream" });


export type Env = {
  JSON_HEADERS: Record<string, string>;
  DEV_USER_ID: string;
  BUILD_MARKER: string;

  MIN_STEPS: number;
  MAX_STEPS: number;

  OLLAMA_URL: string;
  FAST_MODEL: string;
  SMART_MODEL: string;
  REPAIR_MODEL: string;
};

export type Ctx = {
  supabase: SupabaseClient;
  env: Env;
};

// =======================
// Generic utils
// =======================
export function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizePriority(v: unknown): "low" | "medium" | "high" {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "low" || s === "medium" || s === "high") return s;
  return "medium";
}

export function cleanText(s: string, maxLen: number) {
  let t = String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();

  // targeted fixes from observed outputs
  t = t.replace(/'\s*(end-user|thelived|ty)\b/gi, "");
  t = t.replace(/\s+/g, " ").trim();

  if (t.length > maxLen) {
    const cut = t.lastIndexOf(" ", maxLen);
    t = (cut > 20 ? t.slice(0, cut) : t.slice(0, maxLen)).trim();
  }

  if (t && !/[.!?]$/.test(t)) t += ".";
  return t;
}

// =======================
// JSON parsing helpers
// =======================
export function stripFences(s: string) {
  return s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
}

export function maybeTruncatedJSON(s: string) {
  const t = s.trim();
  if (!t) return true;
  const startsJSON = t.startsWith("{") || t.startsWith("[");
  const endsJSON = t.endsWith("}") || t.endsWith("]");
  return startsJSON && !endsJSON;
}

export function tryParseJSON(raw: string): any | null {
  if (!raw) return null;
  const stripped = stripFences(raw);
  if (maybeTruncatedJSON(stripped)) return null;

  try {
    return JSON.parse(stripped);
  } catch {
    // Try extracting object
    const fb = stripped.indexOf("{");
    const lb = stripped.lastIndexOf("}");
    if (fb !== -1 && lb !== -1 && lb > fb) {
      try {
        return JSON.parse(stripped.slice(fb, lb + 1));
      } catch {}
    }
    // Try extracting array
    const fbr = stripped.indexOf("[");
    const lbr = stripped.lastIndexOf("]");
    if (fbr !== -1 && lbr !== -1 && lbr > fbr) {
      try {
        return JSON.parse(stripped.slice(fbr, lbr + 1));
      } catch {}
    }
  }
  return null;
}

// =======================
// Ollama helpers
// =======================
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export async function ollamaChat(params: {
  ollamaUrl: string;
  model: string;
  prompt: string;
  num_predict: number;
  timeoutMs: number;
}): Promise<string> {
  const { ollamaUrl, model, prompt, num_predict, timeoutMs } = params;

  const payload = {
    model,
    stream: false,
    options: { temperature: 0, num_predict },
    messages: [
      {
        role: "system",
        content: "Return ONLY valid MINIFIED JSON (single line). No markdown. No commentary. No trailing commas.",
      },
      { role: "user", content: prompt },
    ],
    format: "json",
  };

  const res = await fetchWithTimeout(
    ollamaUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error (${res.status}): ${text}`);
  }

  const json = await res.json();
  const content = json?.message?.content;
  if (!content) throw new Error("Ollama returned no message.content");
  return content;
}

export async function callJSON(params: {
  ollamaUrl: string;
  model: string;
  prompt: string;
  num_predict: number;
  timeoutMs: number;
  repairModel: string;
  repairNumPredict: number;
  repairTimeoutMs: number;
  requiredKeys?: string[]; // optional, used to guide repair prompt
}): Promise<any> {
  const {
    ollamaUrl,
    model,
    prompt,
    num_predict,
    timeoutMs,
    repairModel,
    repairNumPredict,
    repairTimeoutMs,
    requiredKeys,
  } = params;

  const a1 = await ollamaChat({ ollamaUrl, model, prompt, num_predict, timeoutMs });
  const p1 = tryParseJSON(a1);
  if (p1) return p1;

  const keysLine = requiredKeys?.length
    ? `Fix the JSON so it parses and contains these keys:\n${requiredKeys.join(", ")}.`
    : `Fix the JSON so it parses.`;

  const repairPrompt = `Return ONLY corrected MINIFIED JSON on one line.
No extra keys. No markdown.

${keysLine}

MALFORMED OUTPUT:
${a1}`;

  const r = await ollamaChat({
    ollamaUrl,
    model: repairModel,
    prompt: repairPrompt,
    num_predict: repairNumPredict,
    timeoutMs: repairTimeoutMs,
  });

  const pr = tryParseJSON(r);
  if (pr) return pr;

  throw new Error(`Model returned non-JSON after attempt+repair. A1=${a1.slice(0, 500)} | R=${r.slice(0, 500)}`);
}
// shared.ts (additions)
export function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  };
}

export function sseEvent(event: string, data: unknown) {
  // SSE format: event + data + blank line
  // data MUST be a single line; JSON.stringify ensures that.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Streams Ollama /api/chat response (stream=true) token-by-token.
 * Returns the full concatenated content for parsing later.
 *
 * Ollama emits NDJSON lines. Each line is a JSON object.
 * We extract message.content deltas and forward them.
 */
export async function ollamaChatStream(params: {
  ollamaUrl: string;
  model: string;
  prompt: string;
  num_predict: number;
  timeoutMs: number;
  onToken: (delta: string) => void;
  onRawLine?: (line: string) => void;
}): Promise<string> {
  const { ollamaUrl, model, prompt, num_predict, timeoutMs, onToken, onRawLine } = params;

  const payload = {
    model,
    stream: true,
    options: { temperature: 0, num_predict },
    messages: [
      {
        role: "system",
        content: "Return ONLY valid MINIFIED JSON (single line). No markdown. No commentary. No trailing commas.",
      },
      { role: "user", content: prompt },
    ],
    format: "json",
  };

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  let full = "";

  try {
    const res = await fetch(ollamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
    }
    if (!res.body) {
      throw new Error("Ollama returned no body (stream unavailable).");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // Ollama streams newline-delimited JSON
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);

        if (!line) continue;
        onRawLine?.(line);

        try {
          const obj = JSON.parse(line);
          // token delta
          const delta = obj?.message?.content ?? "";
          if (delta) {
            full += delta;
            onToken(delta);
          }
          if (obj?.done) {
            // done == true ends stream
            break;
          }
        } catch {
          // ignore malformed line fragments (rare)
        }
      }
    }

    return full;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Streaming variant of callJSON:
 * - streams first attempt
 * - tries to parse
 * - if parse fails, does a non-stream repair pass (keeps it simple)
 */
export async function callJSONStream(params: {
  ollamaUrl: string;
  model: string;
  prompt: string;
  num_predict: number;
  timeoutMs: number;

  repairModel: string;
  repairNumPredict: number;
  repairTimeoutMs: number;

  requiredKeys?: string[];
  onToken: (delta: string) => void;
}): Promise<{ parsed: any; raw: string }> {
  const {
    ollamaUrl,
    model,
    prompt,
    num_predict,
    timeoutMs,
    repairModel,
    repairNumPredict,
    repairTimeoutMs,
    requiredKeys,
    onToken,
  } = params;

  const raw1 = await ollamaChatStream({
    ollamaUrl,
    model,
    prompt,
    num_predict,
    timeoutMs,
    onToken,
  });

  const p1 = tryParseJSON(raw1);
  if (p1) return { parsed: p1, raw: raw1 };

  // repair (non-stream, simplest)
  const keysLine = requiredKeys?.length
    ? `Fix the JSON so it parses and contains these keys: ${requiredKeys.join(", ")}.`
    : "Fix the JSON so it parses.";

  const repairPrompt = `Return ONLY corrected MINIFIED JSON on one line.
No extra keys. No markdown.
${keysLine}

MALFORMED OUTPUT:
${raw1}`;

  const raw2 = await ollamaChat({
    ollamaUrl,
    model: repairModel,
    prompt: repairPrompt,
    num_predict: repairNumPredict,
    timeoutMs: repairTimeoutMs,
  });

  const p2 = tryParseJSON(raw2);
  if (p2) return { parsed: p2, raw: raw2 };

  throw new Error(`Model returned non-JSON after attempt+repair. A1=${raw1.slice(0, 500)} | R=${raw2.slice(0, 500)}`);
}
