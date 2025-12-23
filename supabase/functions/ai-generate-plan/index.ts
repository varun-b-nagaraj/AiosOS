// supabase/functions/ai-generate-plan/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// ============================================================
// TYPE DEFINITIONS
// ============================================================

type GeneratePlanBody = {
  mode: "generate_plan";
  person_name?: string;
  user_id?: string;
  company_name: string;
  company_title: string;
  short_description: string;
  long_description?: string | null;
};

type DeepDiveBody = {
  mode: "deep_dive";
  plan_id: string;
  step_key: string;
};

type Body = GeneratePlanBody | DeepDiveBody;

// ============================================================
// CONSTANTS
// ============================================================
const JSON_HEADERS = { "Content-Type": "application/json" };
const DEV_USER_ID = "00000000-0000-0000-0000-000000000000"; // TODO: replace with auth.uid later
const BUILD_MARKER = "ai-generate-plan stepwise-dynamicN 2025-12-23-03";

// Guardrails to prevent “too many model calls” in a single HTTP request.
const MIN_STEPS = 3;
const MAX_STEPS = 10; // hard cap for reliability (prevents upstream timeouts)

// ============================================================
// JSON SCHEMAS (for reference / validation)
// ============================================================

type StepRow = {
  plan_id: string;
  step_key: string;
  order_index: number;
  title: string;
  details: string;
  success_criteria: string;
  priority: "low" | "medium" | "high";
  estimated_minutes: number;
  status: "not_started" | "in_progress" | "done";
};

type OutlineStep = {
  step_key: string; // step_1..step_n
  title: string;
};

type OutlineResponse = {
  step_count: number;
  steps: OutlineStep[];
};

type StepGenResponse = {
  step_key: string;
  title: string;
  priority: "low" | "medium" | "high";
  details: string;
  success_criteria: string;
  estimated_minutes: number;
};

// ============================================================
// OLLAMA HELPERS
// ============================================================
function cleanText(s: string, maxLen: number) {
  let t = String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();

  // Remove rare glue artifacts but don't over-delete normal apostrophes
  t = t.replace(/'\s*(end-user|thelived|ty)\b/gi, ""); // targeted fixes from your observed outputs
  t = t.replace(/\s+/g, " ").trim();

  // If too long, cut at last space before maxLen (no mid-word cut)
  if (t.length > maxLen) {
    const cut = t.lastIndexOf(" ", maxLen);
    t = (cut > 20 ? t.slice(0, cut) : t.slice(0, maxLen)).trim();
  }

  // Ensure it ends with punctuation
  if (t && !/[.!?]$/.test(t)) t += ".";

  return t;
}


function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizePriority(v: unknown): "low" | "medium" | "high" {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "low" || s === "medium" || s === "high") return s;
  return "medium";
}

function stripFences(s: string) {
  return s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
}

function maybeTruncatedJSON(s: string) {
  const t = s.trim();
  if (!t) return true;
  // If it starts like JSON but doesn't end like JSON, treat as truncated.
  const startsJSON = t.startsWith("{") || t.startsWith("[");
  const endsJSON = t.endsWith("}") || t.endsWith("]");
  return startsJSON && !endsJSON;
}

function tryParseJSON(raw: string): any | null {
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

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function ollamaChat(params: {
  ollamaUrl: string;
  model: string;
  prompt: string;
  num_predict: number;
  timeoutMs: number;
}): Promise<string> {
  const { ollamaUrl, model, prompt, num_predict, timeoutMs } = params;

  // We intentionally use format:"json" (not schema) for reliability with small models.
  // We validate and coerce ourselves.
  const payload = {
    model,
    stream: false,
    options: { temperature: 0, num_predict },
    messages: [
      {
        role: "system",
        content:
          "Return ONLY valid MINIFIED JSON (single line). No markdown. No commentary. No trailing commas.",
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

async function callJSON(params: {
  ollamaUrl: string;
  model: string;
  prompt: string;
  num_predict: number;
  timeoutMs: number;
  // optional repair pass
  repairModel: string;
  repairNumPredict: number;
  repairTimeoutMs: number;
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
  } = params;

  const a1 = await ollamaChat({ ollamaUrl, model, prompt, num_predict, timeoutMs });
  const p1 = tryParseJSON(a1);
  if (p1) return p1;

  // Repair pass: ask a (usually small/fast) model to output correct JSON only.
const repairPrompt = `Return ONLY corrected MINIFIED JSON on one line.
No extra keys. No markdown.

Fix the JSON so it parses and contains these keys:
details, success_criteria, priority, estimated_minutes.

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

// ============================================================
// MODEL PROMPTS (STEPWISE, DYNAMIC N)
// ============================================================

function outlinePrompt(input: {
  company_name: string;
  company_title: string;
  short_description: string;
  long_description?: string | null;
}) {
  const { company_name, company_title, short_description, long_description } = input;

  // Primary call: determine how many steps AND list step titles (very small output).
  // We do not ask for details here to keep it fast and avoid truncation.
  return `Create an onboarding plan outline.

Return MINIFIED JSON exactly in this shape:
{"step_count":N,"steps":[{"step_key":"step_1","title":"..."}, ...]}

Rules:
- Choose N based on complexity. N must be an integer between ${MIN_STEPS} and ${MAX_STEPS}.
- step_count MUST equal steps.length.
- step_key must be exactly "step_1"..."step_N" (no gaps).
- title: <= 40 characters, action-oriented, non-redundant.
- Output only JSON. One line. No extra keys.

Company: ${company_name.trim()}
Title: ${company_title.trim()}
Description: ${short_description.trim()}
${long_description?.trim() ? `Additional context: ${long_description.trim()}` : ""}`;
}

function stepPrompt(input: {
  company_name: string;
  company_title: string;
  short_description: string;
  long_description?: string | null;
  step_key: string;
  title: string;
  step_count: number;
}) {
  const { company_name, company_title, short_description, long_description, step_key, title, step_count } = input;

  return `Return ONLY valid MINIFIED JSON on one line.

You must fill VALUES for details/success_criteria/priority/estimated_minutes only.

DO NOT change step_key or title. Copy them EXACTLY.

JSON TEMPLATE (copy exactly, only replace the ... and NN values):
{"step_key":"${step_key}","title":"${title}","priority":"medium","details":"...","success_criteria":"...","estimated_minutes":NN}

Rules:
- step_key MUST be exactly "${step_key}" (no other text).
- title MUST be exactly "${title}" (no other text).
- details: one sentence, <= 90 chars.
- success_criteria: one sentence, <= 80 chars.
- priority: low|medium|high.
- estimated_minutes: integer 10..90.
- No extra keys. No markdown.

Context:
Company: ${company_name.trim()}
Role: ${company_title.trim()}
Description: ${short_description.trim()}
${long_description?.trim() ? `More: ${long_description.trim()}` : ""}
Step ${step_key} of ${step_count}.`;
}


// ============================================================
// VALIDATION / NORMALIZATION
// ============================================================

function normalizeOutline(raw: any): OutlineResponse {
  const stepsRaw = Array.isArray(raw?.steps) ? raw.steps : [];
  const step_count = clampInt(Number(raw?.step_count ?? stepsRaw.length), MIN_STEPS, MAX_STEPS);

  // Build step list in order, enforce keys step_1..step_N, enforce title presence.
  const byKey = new Map<string, string>();
  for (const s of stepsRaw) {
    const k = String(s?.step_key ?? "").trim();
    const t = String(s?.title ?? "").trim();
    if (k && t) byKey.set(k, t);
  }

  const steps: OutlineStep[] = [];
  for (let i = 1; i <= step_count; i++) {
    const k = `step_${i}`;
    const t = (byKey.get(k) ?? "").trim();
    steps.push({
      step_key: k,
      title: t || `Step ${i}`,
    });
  }

  return { step_count, steps };
}

function normalizeStepGen(raw: any, expectedKey: string, expectedTitle: string): StepGenResponse {
  const details = cleanText(raw?.details ?? "", 120);
  const success_criteria = cleanText(raw?.success_criteria ?? "", 110);
  const estimated_minutes = clampInt(Number(raw?.estimated_minutes ?? 30), 10, 90);
  const priority = normalizePriority(raw?.priority);

  if (!details) throw new Error(`Missing details for ${expectedKey}`);
  if (!success_criteria) throw new Error(`Missing success_criteria for ${expectedKey}`);

  // Force identifiers to be correct regardless of model output
  return {
    step_key: expectedKey,
    title: expectedTitle,
    priority,
    details,
    success_criteria,
    estimated_minutes,
  };
}


// ============================================================
// MAIN HANDLER
// ============================================================

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed", build_marker: BUILD_MARKER }), {
        status: 405,
        headers: JSON_HEADERS,
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return new Response(
        JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", build_marker: BUILD_MARKER }),
        { status: 500, headers: JSON_HEADERS },
      );
    }

    const OLLAMA_URL = Deno.env.get("OLLAMA_URL") ?? "http://host.docker.internal:11434/api/chat";
    const FAST_MODEL = Deno.env.get("FAST_MODEL") ?? "phi3:mini";
    const SMART_MODEL = Deno.env.get("SMART_MODEL") ?? "llama3.1:8b";
    const REPAIR_MODEL = Deno.env.get("REPAIR_MODEL") ?? "phi3:mini";

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = (await req.json()) as Body;
    if (!body?.mode) {
      return new Response(JSON.stringify({ error: "Missing mode in request body", build_marker: BUILD_MARKER }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    // ============================================================
    // MODE: GENERATE_PLAN (Dynamic N + step-by-step generation)
    // ============================================================
    if (body.mode === "generate_plan") {
        const { company_name, company_title, short_description, person_name, long_description } = body;
      const user_id = (body.user_id?.trim() || DEV_USER_ID);


      if (!company_name?.trim() || !company_title?.trim() || !short_description?.trim()) {
        return new Response(
          JSON.stringify({
            error: "company_name, company_title, and short_description are required",
            build_marker: BUILD_MARKER,
          }),
          { status: 400, headers: JSON_HEADERS },
        );
      }

      // 1) Create plan row immediately (so we have plan_id even if model generation fails later).
      const { data: planRow, error: planErr } = await supabase
        .from("plans")
        .insert({
          user_id,
          person_name: person_name?.trim() || null,
          company_name: company_name.trim(),
          company_title: company_title.trim(),
          short_description: short_description.trim(),
          long_description: long_description?.trim() || null,
          model: FAST_MODEL,
        })
        .select("id")
        .single();

      if (planErr || !planRow) {
        return new Response(
          JSON.stringify({ error: "Failed to insert plan", detail: planErr, build_marker: BUILD_MARKER }),
          { status: 500, headers: JSON_HEADERS },
        );
      }

      const plan_id = planRow.id as string;

      // 2) Outline call: decide step count + titles (small/fast).
      const outlineRaw = await callJSON({
        ollamaUrl: OLLAMA_URL,
        model: FAST_MODEL,
        prompt: outlinePrompt({ company_name, company_title, short_description, long_description }),
        num_predict: 260, // small output
        timeoutMs: 35_000,
        repairModel: REPAIR_MODEL,
        repairNumPredict: 260,
        repairTimeoutMs: 20_000,
      });

      const outline = normalizeOutline(outlineRaw);
      for (let i = 0; i < outline.steps.length; i++) {
        const t = outline.steps[i].title.trim();
        // If model returned placeholder or too-generic title, force a better fallback
        if (!t || /^step\s*\d+$/i.test(t) || t.length < 6) {
          outline.steps[i].title = `Define step ${i + 1} deliverable`;
        }
      }

      // 3) Insert placeholder rows first (lets UI show skeletons immediately if you later add async mode).
      const placeholders: StepRow[] = outline.steps.map((s, idx) => ({
        plan_id,
        step_key: s.step_key,
        order_index: idx + 1,
        title: s.title,
        details: "",
        success_criteria: "",
        priority: "medium",
        estimated_minutes: 30,
        status: "not_started",
      }));

      // Best-effort: placeholders (if your table has NOT NULL constraints on details, skip placeholders)
      // If this insert fails due to constraints, we will generate fully then insert once.
      let insertedPlaceholders = true;
      const { error: phErr } = await supabase.from("plan_steps").insert(placeholders);
      if (phErr) insertedPlaceholders = false;

      // 4) Generate each step one-by-one (small responses; highest reliability).
      const generated: StepRow[] = [];
      for (let i = 0; i < outline.steps.length; i++) {
        const s = outline.steps[i];

        const raw = await callJSON({
          ollamaUrl: OLLAMA_URL,
          model: FAST_MODEL,
          prompt: stepPrompt({
            company_name,
            company_title,
            short_description,
            long_description,
            step_key: s.step_key,
            title: s.title,
            step_count: outline.step_count,
          }),
          num_predict: 260, // still small
          timeoutMs: 35_000,
          repairModel: REPAIR_MODEL,
          repairNumPredict: 260,
          repairTimeoutMs: 20_000,
        });

        const stepGen = normalizeStepGen(raw, s.step_key, s.title);

        const row: StepRow = {
          plan_id,
          step_key: stepGen.step_key,
          order_index: i + 1,
          title: stepGen.title,
          details: stepGen.details,
          success_criteria: stepGen.success_criteria,
          priority: stepGen.priority,
          estimated_minutes: stepGen.estimated_minutes,
          status: "not_started",
        };

        generated.push(row);

        // Persist as we go:
        if (insertedPlaceholders) {
          const { error: upErr } = await supabase
            .from("plan_steps")
            .update({
              details: row.details,
              success_criteria: row.success_criteria,
              priority: row.priority,
              estimated_minutes: row.estimated_minutes,
            })
            .eq("plan_id", plan_id)
            .eq("step_key", row.step_key);

          if (upErr) {
            // If update fails, fall back to “insert all at end” approach.
            insertedPlaceholders = false;
          }
        }
      }

      // 5) If placeholders were not inserted (constraints) OR updates failed, do a clean insert:
      if (!insertedPlaceholders) {
        // Clear any partial rows (best effort; if RLS/constraints prevent, the insert below may duplicate)
        try {
          await supabase.from("plan_steps").delete().eq("plan_id", plan_id);
        } catch {
          // ignore
        }

        const { error: insErr } = await supabase.from("plan_steps").insert(generated);
        if (insErr) {
          return new Response(
            JSON.stringify({ error: "Failed to insert generated steps", detail: insErr, build_marker: BUILD_MARKER }),
            { status: 500, headers: JSON_HEADERS },
          );
        }
      }

      return new Response(
        JSON.stringify({
          mode: "generate_plan",
          plan_id,
          model_used: FAST_MODEL,
          step_count: outline.step_count,
          steps: generated,
          build_marker: BUILD_MARKER,
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }

    // ============================================================
    // MODE: DEEP_DIVE (kept as single call; you can keep your schema version if you want)
    // ============================================================
    if (body.mode === "deep_dive") {
      const { plan_id, step_key } = body;

      if (!plan_id?.trim() || !step_key?.trim()) {
        return new Response(JSON.stringify({ error: "plan_id and step_key are required", build_marker: BUILD_MARKER }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }

      const { data: plan, error: planFetchErr } = await supabase
        .from("plans")
        .select("id, company_name, company_title, short_description, long_description, person_name")
        .eq("id", plan_id.trim())
        .single();

      if (planFetchErr || !plan) {
        return new Response(
          JSON.stringify({ error: "Plan not found", detail: planFetchErr, build_marker: BUILD_MARKER }),
          { status: 404, headers: JSON_HEADERS },
        );
      }

      const { data: step, error: stepFetchErr } = await supabase
        .from("plan_steps")
        .select("step_key, title, details, success_criteria, priority, estimated_minutes")
        .eq("plan_id", plan_id.trim())
        .eq("step_key", step_key.trim())
        .single();

      if (stepFetchErr || !step) {
        return new Response(
          JSON.stringify({ error: "Step not found", detail: stepFetchErr, build_marker: BUILD_MARKER }),
          { status: 404, headers: JSON_HEADERS },
        );
      }

      // Deep dive output can be large; still keep JSON-minified.
      const prompt = `Return ONLY valid MINIFIED JSON (single line).

Create a detailed playbook for completing this onboarding step.

Return JSON with keys:
{"step_key":"${step_key.trim()}","summary":"...","why_it_matters":"...","prerequisites":["..."],"sub_tasks":[{"title":"...","acceptance_criteria":"...","estimated_minutes":NN}], "pitfalls":["..."],"questions_to_answer":["..."],"next_action":"..."}

Rules:
- step_key MUST be exactly "${step_key}".
- title MUST be exactly "${step.title}".
- details: ONE sentence, 8–14 words, NO apostrophes, NO semicolons.
- success_criteria: ONE sentence, 6–12 words, NO apostrophes, NO semicolons.
- estimated_minutes: integer 10..90.
- priority: exactly one of low|medium|high.
- Output only JSON, one line, no extra keys.


COMPANY:
Person: ${plan.person_name ?? "(not provided)"}
Company: ${plan.company_name}
Title: ${plan.company_title}
Description: ${plan.short_description}
${plan.long_description ? `Additional context: ${plan.long_description}` : ""}

STEP:
Step ID: ${step.step_key}
Title: ${step.title}
Priority: ${step.priority}
Details: ${step.details}
Success Criteria: ${step.success_criteria}
Estimated Time: ${step.estimated_minutes} minutes`;

      const deep = await callJSON({
        ollamaUrl: OLLAMA_URL,
        model: SMART_MODEL,
        prompt,
        num_predict: 1200,
        timeoutMs: 80_000,
        repairModel: REPAIR_MODEL,
        repairNumPredict: 900,
        repairTimeoutMs: 35_000,
      });

      // Optional persistence if table exists
      try {
        await supabase.from("plan_step_details").upsert({
          plan_id: plan_id.trim(),
          step_key: step_key.trim(),
          details_json: deep,
          model: SMART_MODEL,
        });
      } catch {
        // ignore if table doesn't exist yet
      }

      return new Response(
        JSON.stringify({
          mode: "deep_dive",
          plan_id: plan_id.trim(),
          step_key: step_key.trim(),
          model_used: SMART_MODEL,
          deep_dive: deep,
          build_marker: BUILD_MARKER,
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown mode. Use 'generate_plan' or 'deep_dive'", build_marker: BUILD_MARKER }),
      { status: 400, headers: JSON_HEADERS },
    );
  } catch (e) {
    console.error("[Error]", e);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        build_marker: BUILD_MARKER,
        detail: e instanceof Error ? e.message : String(e),
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});
