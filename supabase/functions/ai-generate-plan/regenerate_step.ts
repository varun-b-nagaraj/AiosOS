import type { Ctx } from "./shared.ts";
import {
  callJSON,
  callJSONStream,
  cleanText,
  clampInt,
  normalizePriority,
  sseHeaders,
  sseEvent,
} from "./shared.ts";

export type RegenerateStepBody = {
  mode: "regenerate_step";
  stream?: boolean; // default true in index router
  plan_id: string;
  step_key: string;
  user_feedback?: string;
  constraints?: Record<string, unknown>;
};

function regenPrompt(input: {
  plan: any;
  step: any;
  user_feedback?: string;
  constraints?: Record<string, unknown>;
}) {
  const { plan, step, user_feedback, constraints } = input;

  return `You are regenerating ONE onboarding step.

Return ONLY valid MINIFIED JSON on one line.

JSON TEMPLATE (copy exactly, only replace values):
{"details":"...","success_criteria":"...","priority":"medium","estimated_minutes":NN}

Rules:
- details: one sentence, <= 90 chars.
- success_criteria: one sentence, <= 80 chars.
- priority: low | medium | high.
- estimated_minutes: integer 10..90.
- No extra keys. No markdown.

ORIGINAL STEP:
Title: ${step.title}
Details: ${step.details}
Success Criteria: ${step.success_criteria}
Priority: ${step.priority}
Estimated Minutes: ${step.estimated_minutes}

PLAN CONTEXT:
Company: ${plan.company_name}
Role: ${plan.company_title}
Description: ${plan.short_description}
${plan.long_description ? `More: ${plan.long_description}` : ""}

USER FEEDBACK:
${user_feedback?.trim() || "(none)"}

CONSTRAINTS:
${constraints ? JSON.stringify(constraints) : "(none)"}

Improve clarity, usefulness, and specificity. Do NOT repeat the original wording verbatim.`;
}

// -------------------------
// Non-stream (stream:false)
// -------------------------
export async function handleRegenerateStep(ctx: Ctx, body: RegenerateStepBody): Promise<Response> {
  const { supabase, env } = ctx;
  const plan_id = body.plan_id?.trim();
  const step_key = body.step_key?.trim();

  if (!plan_id || !step_key) {
    return new Response(JSON.stringify({ error: "plan_id and step_key are required" }), {
      status: 400,
      headers: env.JSON_HEADERS,
    });
  }

  const { data: step, error: stepErr } = await supabase
    .from("plan_steps")
    .select("title, details, success_criteria, priority, estimated_minutes")
    .eq("plan_id", plan_id)
    .eq("step_key", step_key)
    .single();

  if (stepErr || !step) {
    return new Response(JSON.stringify({ error: "Step not found", detail: stepErr }), {
      status: 404,
      headers: env.JSON_HEADERS,
    });
  }

  const { data: plan, error: planErr } = await supabase
    .from("plans")
    .select("company_name, company_title, short_description, long_description")
    .eq("id", plan_id)
    .single();

  if (planErr || !plan) {
    return new Response(JSON.stringify({ error: "Plan not found", detail: planErr }), {
      status: 404,
      headers: env.JSON_HEADERS,
    });
  }

  const raw = await callJSON({
    ollamaUrl: env.OLLAMA_URL,
    model: env.FAST_MODEL,
    prompt: regenPrompt({ plan, step, user_feedback: body.user_feedback, constraints: body.constraints }),
    num_predict: 260,
    timeoutMs: 35_000,
    repairModel: env.REPAIR_MODEL,
    repairNumPredict: 260,
    repairTimeoutMs: 20_000,
  });

  const updated = {
    details: cleanText(raw?.details ?? "", 120),
    success_criteria: cleanText(raw?.success_criteria ?? "", 110),
    priority: normalizePriority(raw?.priority),
    estimated_minutes: clampInt(Number(raw?.estimated_minutes ?? step.estimated_minutes), 10, 90),
  };

  if (!updated.details || !updated.success_criteria) {
    return new Response(JSON.stringify({ error: "Model returned invalid step content", raw }), {
      status: 500,
      headers: env.JSON_HEADERS,
    });
  }

  const { error: updateErr } = await supabase
    .from("plan_steps")
    .update(updated)
    .eq("plan_id", plan_id)
    .eq("step_key", step_key);

  if (updateErr) {
    return new Response(JSON.stringify({ error: "Failed to update step", detail: updateErr }), {
      status: 500,
      headers: env.JSON_HEADERS,
    });
  }

  return new Response(
    JSON.stringify({
      mode: "regenerate_step",
      plan_id,
      step_key,
      updated_step: updated,
      build_marker: env.BUILD_MARKER,
    }),
    { status: 200, headers: env.JSON_HEADERS },
  );
}

// -------------------------
// Stream (default)
// -------------------------
export async function handleRegenerateStepStream(ctx: Ctx, body: RegenerateStepBody): Promise<Response> {
  const { supabase, env } = ctx;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sseEvent(event, data)));

      (async () => {
        try {
          const plan_id = body.plan_id?.trim();
          const step_key = body.step_key?.trim();

          send("status", { phase: "start", build_marker: env.BUILD_MARKER });

          if (!plan_id || !step_key) {
            send("error", { error: "plan_id and step_key are required" });
            controller.close();
            return;
          }

          send("status", { phase: "db_fetch_step" });
          const { data: step, error: stepErr } = await supabase
            .from("plan_steps")
            .select("title, details, success_criteria, priority, estimated_minutes")
            .eq("plan_id", plan_id)
            .eq("step_key", step_key)
            .single();

          if (stepErr || !step) {
            send("error", { error: "Step not found", detail: stepErr });
            controller.close();
            return;
          }

          send("status", { phase: "db_fetch_plan" });
          const { data: plan, error: planErr } = await supabase
            .from("plans")
            .select("company_name, company_title, short_description, long_description")
            .eq("id", plan_id)
            .single();

          if (planErr || !plan) {
            send("error", { error: "Plan not found", detail: planErr });
            controller.close();
            return;
          }

          // Optional: let UI render context immediately
          send("status", { phase: "context_ready", plan_id, step_key, step_title: step.title });

          send("status", { phase: "model_call_start", model: env.FAST_MODEL });

          const res = await callJSONStream({
            ollamaUrl: env.OLLAMA_URL,
            model: env.FAST_MODEL,
            prompt: regenPrompt({ plan, step, user_feedback: body.user_feedback, constraints: body.constraints }),
            num_predict: 260,
            timeoutMs: 35_000,
            repairModel: env.REPAIR_MODEL,
            repairNumPredict: 260,
            repairTimeoutMs: 20_000,
            requiredKeys: ["details", "success_criteria", "priority", "estimated_minutes"],
            onToken: (delta) => {
              // recommended: reduce spam
              if (!delta || delta.trim().length === 0) return;
              send("token", { scope: "regenerate_step", step_key, delta });
            },
          });

          send("status", { phase: "model_call_done" });

          const raw = res.parsed;

          const updated = {
            details: cleanText(raw?.details ?? "", 120),
            success_criteria: cleanText(raw?.success_criteria ?? "", 110),
            priority: normalizePriority(raw?.priority),
            estimated_minutes: clampInt(Number(raw?.estimated_minutes ?? step.estimated_minutes), 10, 90),
          };

          if (!updated.details || !updated.success_criteria) {
            send("error", { error: "Model returned invalid step content", raw });
            controller.close();
            return;
          }

          send("status", { phase: "db_update_step" });
          const { error: updateErr } = await supabase
            .from("plan_steps")
            .update(updated)
            .eq("plan_id", plan_id)
            .eq("step_key", step_key);

          if (updateErr) {
            send("error", { error: "Failed to update step", detail: updateErr });
            controller.close();
            return;
          }

          send("done", {
            mode: "regenerate_step",
            plan_id,
            step_key,
            updated_step: updated,
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
