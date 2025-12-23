import type { Ctx, GeneratePlanBody } from "./shared.ts";
import {
  callJSON,
  callJSONStream,
  cleanText,
  clampInt,
  normalizePriority,
  sseHeaders,
  sseEvent,
} from "./shared.ts";

type GeneratePlanStreamBody = Omit<GeneratePlanBody, "mode"> & { mode: "generate_plan_stream" };

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

type OutlineStep = { step_key: string; title: string };
type OutlineResponse = { step_count: number; steps: OutlineStep[] };

// ============================================================
// PROMPTS
// ============================================================

function outlinePrompt(
  input: { company_name: string; company_title: string; short_description: string; long_description?: string | null },
  MIN_STEPS: number,
  MAX_STEPS: number,
) {
  const { company_name, company_title, short_description, long_description } = input;

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
// NORMALIZATION
// ============================================================

function normalizeOutline(raw: any, MIN_STEPS: number, MAX_STEPS: number): OutlineResponse {
  const stepsRaw = Array.isArray(raw?.steps) ? raw.steps : [];
  const step_count = clampInt(Number(raw?.step_count ?? stepsRaw.length), MIN_STEPS, MAX_STEPS);

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
    steps.push({ step_key: k, title: t || `Step ${i}` });
  }

  return { step_count, steps };
}

function normalizeStepGen(raw: any, expectedKey: string, expectedTitle: string) {
  const details = cleanText(raw?.details ?? "", 120);
  const success_criteria = cleanText(raw?.success_criteria ?? "", 110);
  const estimated_minutes = clampInt(Number(raw?.estimated_minutes ?? 30), 10, 90);
  const priority = normalizePriority(raw?.priority);

  if (!details) throw new Error(`Missing details for ${expectedKey}`);
  if (!success_criteria) throw new Error(`Missing success_criteria for ${expectedKey}`);

  return { step_key: expectedKey, title: expectedTitle, priority, details, success_criteria, estimated_minutes };
}

// ============================================================
// NON-STREAM HANDLER (your current behavior)
// ============================================================

export async function handleGeneratePlan(ctx: Ctx, body: GeneratePlanBody): Promise<Response> {
  const { supabase, env } = ctx;
  const { company_name, company_title, short_description, person_name, long_description } = body;
  const user_id = body.user_id?.trim() || env.DEV_USER_ID;

  if (!company_name?.trim() || !company_title?.trim() || !short_description?.trim()) {
    return new Response(
      JSON.stringify({ error: "company_name, company_title, and short_description are required", build_marker: env.BUILD_MARKER }),
      { status: 400, headers: env.JSON_HEADERS },
    );
  }

  const { data: planRow, error: planErr } = await supabase
    .from("plans")
    .insert({
      user_id,
      person_name: person_name?.trim() || null,
      company_name: company_name.trim(),
      company_title: company_title.trim(),
      short_description: short_description.trim(),
      long_description: long_description?.trim() || null,
      model: env.FAST_MODEL,
    })
    .select("id")
    .single();

  if (planErr || !planRow) {
    return new Response(JSON.stringify({ error: "Failed to insert plan", detail: planErr, build_marker: env.BUILD_MARKER }), {
      status: 500,
      headers: env.JSON_HEADERS,
    });
  }

  const plan_id = planRow.id as string;

  const outlineRaw = await callJSON({
    ollamaUrl: env.OLLAMA_URL,
    model: env.FAST_MODEL,
    prompt: outlinePrompt({ company_name, company_title, short_description, long_description }, env.MIN_STEPS, env.MAX_STEPS),
    num_predict: 260,
    timeoutMs: 35_000,
    repairModel: env.REPAIR_MODEL,
    repairNumPredict: 260,
    repairTimeoutMs: 20_000,
  });

  const outline = normalizeOutline(outlineRaw, env.MIN_STEPS, env.MAX_STEPS);
  for (let i = 0; i < outline.steps.length; i++) {
    const t = outline.steps[i].title.trim();
    if (!t || /^step\s*\d+$/i.test(t) || t.length < 6) outline.steps[i].title = `Define step ${i + 1} deliverable`;
  }

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

  let insertedPlaceholders = true;
  const { error: phErr } = await supabase.from("plan_steps").insert(placeholders);
  if (phErr) insertedPlaceholders = false;

  const generated: StepRow[] = [];

  for (let i = 0; i < outline.steps.length; i++) {
    const s = outline.steps[i];

    const raw = await callJSON({
      ollamaUrl: env.OLLAMA_URL,
      model: env.FAST_MODEL,
      prompt: stepPrompt({
        company_name,
        company_title,
        short_description,
        long_description,
        step_key: s.step_key,
        title: s.title,
        step_count: outline.step_count,
      }),
      num_predict: 260,
      timeoutMs: 35_000,
      repairModel: env.REPAIR_MODEL,
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

      if (upErr) insertedPlaceholders = false;
    }
  }

  if (!insertedPlaceholders) {
    try {
      await supabase.from("plan_steps").delete().eq("plan_id", plan_id);
    } catch {
      // ignore
    }
    const { error: insErr } = await supabase.from("plan_steps").insert(generated);
    if (insErr) {
      return new Response(JSON.stringify({ error: "Failed to insert generated steps", detail: insErr, build_marker: env.BUILD_MARKER }), {
        status: 500,
        headers: env.JSON_HEADERS,
      });
    }
  }

  return new Response(
    JSON.stringify({
      mode: "generate_plan",
      plan_id,
      model_used: env.FAST_MODEL,
      step_count: outline.step_count,
      steps: generated,
      build_marker: env.BUILD_MARKER,
    }),
    { status: 200, headers: env.JSON_HEADERS },
  );
}

// ============================================================
// STREAM HANDLER (SSE)
// ============================================================

export async function handleGeneratePlanStream(ctx: Ctx, body: GeneratePlanStreamBody): Promise<Response> {
  const { supabase, env } = ctx;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(sseEvent(event, data)));
      };

      (async () => {
        try {
          send("status", { phase: "start", build_marker: env.BUILD_MARKER });

          const { company_name, company_title, short_description, person_name, long_description } = body;
          const user_id = body.user_id?.trim() || env.DEV_USER_ID;

          if (!company_name?.trim() || !company_title?.trim() || !short_description?.trim()) {
            send("error", { error: "company_name, company_title, and short_description are required" });
            controller.close();
            return;
          }

          // 1) Create plan row
          send("status", { phase: "db_create_plan" });
          const { data: planRow, error: planErr } = await supabase
            .from("plans")
            .insert({
              user_id,
              person_name: person_name?.trim() || null,
              company_name: company_name.trim(),
              company_title: company_title.trim(),
              short_description: short_description.trim(),
              long_description: long_description?.trim() || null,
              model: env.FAST_MODEL,
            })
            .select("id")
            .single();

          if (planErr || !planRow) {
            send("error", { error: "Failed to insert plan", detail: planErr });
            controller.close();
            return;
          }

          const plan_id = planRow.id as string;
          send("status", { phase: "plan_created", plan_id });

          // 2) Outline (stream tokens)
          send("status", { phase: "outline_model_call" });
          const outlineRes = await callJSONStream({
            ollamaUrl: env.OLLAMA_URL,
            model: env.FAST_MODEL,
            prompt: outlinePrompt({ company_name, company_title, short_description, long_description }, env.MIN_STEPS, env.MAX_STEPS),
            num_predict: 260,
            timeoutMs: 35_000,
            repairModel: env.REPAIR_MODEL,
            repairNumPredict: 260,
            repairTimeoutMs: 20_000,
            onToken: (delta) => {
              // Ignore pure whitespace chunks to reduce spam and choppiness
              if (!delta || delta.trim().length === 0) return;
              send("token", { scope: "outline", delta });
            },
          });

          const outline = normalizeOutline(outlineRes.parsed, env.MIN_STEPS, env.MAX_STEPS);
          for (let i = 0; i < outline.steps.length; i++) {
            const t = outline.steps[i].title.trim();
            if (!t || /^step\s*\d+$/i.test(t) || t.length < 6) outline.steps[i].title = `Define step ${i + 1} deliverable`;
          }

          send("status", { phase: "outline_done", step_count: outline.step_count, steps: outline.steps });

          // 3) Insert placeholders
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

          let insertedPlaceholders = true;
          const { error: phErr } = await supabase.from("plan_steps").insert(placeholders);
          if (phErr) insertedPlaceholders = false;

          // 4) Generate each step with streaming
          const generated: StepRow[] = [];

          for (let i = 0; i < outline.steps.length; i++) {
            const s = outline.steps[i];

            send("status", { phase: "step_start", step_key: s.step_key, title: s.title, index: i + 1, total: outline.step_count });

            const stepRes = await callJSONStream({
              ollamaUrl: env.OLLAMA_URL,
              model: env.FAST_MODEL,
              prompt: stepPrompt({
                company_name,
                company_title,
                short_description,
                long_description,
                step_key: s.step_key,
                title: s.title,
                step_count: outline.step_count,
              }),
              num_predict: 260,
              timeoutMs: 35_000,
              repairModel: env.REPAIR_MODEL,
              repairNumPredict: 260,
              repairTimeoutMs: 20_000,
              requiredKeys: ["details", "success_criteria", "priority", "estimated_minutes"],
              onToken: (delta) => {
                // Ignore pure whitespace chunks to reduce spam and choppiness
                if (!delta || delta.trim().length === 0) return;
                send("token", { scope: "step", step_key: s.step_key, delta });
              },
            });

            const stepGen = normalizeStepGen(stepRes.parsed, s.step_key, s.title);

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

              if (upErr) insertedPlaceholders = false;
            }

            send("status", { phase: "step_done", step_key: s.step_key });
          }

          // 5) Bulk insert fallback
          if (!insertedPlaceholders) {
            send("status", { phase: "db_insert_steps_bulk" });
            try {
              await supabase.from("plan_steps").delete().eq("plan_id", plan_id);
            } catch {
              // ignore
            }
            const { error: insErr } = await supabase.from("plan_steps").insert(generated);
            if (insErr) {
              send("error", { error: "Failed to insert generated steps", detail: insErr });
              controller.close();
              return;
            }
          }

          send("done", {
            mode: "generate_plan_stream",
            plan_id,
            model_used: env.FAST_MODEL,
            step_count: outline.step_count,
            steps: generated,
            build_marker: env.BUILD_MARKER,
          });

          controller.close();
        } catch (e) {
          send("error", { error: "Internal server error", detail: e instanceof Error ? e.message : String(e) });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
