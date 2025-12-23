// supabase/functions/ai-generate-plan/deep_dive.ts
import type { Ctx, DeepDiveBody } from "./shared.ts";
import { callJSON, callJSONStream, sseHeaders, sseEvent } from "./shared.ts";

type DeepDiveStreamBody = Omit<DeepDiveBody, "mode"> & { mode: "deep_dive_stream" };

// ============================================================
// NON-STREAM HANDLER (keep your current one; included for completeness)
// ============================================================

export async function handleDeepDive(ctx: Ctx, body: DeepDiveBody): Promise<Response> {
  const { supabase, env } = ctx;
  const { plan_id, step_key } = body;

  if (!plan_id?.trim() || !step_key?.trim()) {
    return new Response(JSON.stringify({ error: "plan_id and step_key are required", build_marker: env.BUILD_MARKER }), {
      status: 400,
      headers: env.JSON_HEADERS,
    });
  }

  const { data: plan, error: planFetchErr } = await supabase
    .from("plans")
    .select("id, company_name, company_title, short_description, long_description, person_name")
    .eq("id", plan_id.trim())
    .single();

  if (planFetchErr || !plan) {
    return new Response(
      JSON.stringify({ error: "Plan not found", detail: planFetchErr, build_marker: env.BUILD_MARKER }),
      { status: 404, headers: env.JSON_HEADERS },
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
      JSON.stringify({ error: "Step not found", detail: stepFetchErr, build_marker: env.BUILD_MARKER }),
      { status: 404, headers: env.JSON_HEADERS },
    );
  }

  const prompt = `Return ONLY valid MINIFIED JSON (single line).

Create a detailed playbook for completing this onboarding step.

Return JSON with keys:
{"step_key":"${step_key.trim()}","summary":"...","why_it_matters":"...","prerequisites":["..."],"sub_tasks":[{"title":"...","acceptance_criteria":"...","estimated_minutes":NN}],"pitfalls":["..."],"questions_to_answer":["..."],"next_action":"..."}

Rules:
- step_key MUST be exactly "${step_key}".
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
    ollamaUrl: env.OLLAMA_URL,
    model: env.SMART_MODEL,
    prompt,
    num_predict: 1200,
    timeoutMs: 80_000,
    repairModel: env.REPAIR_MODEL,
    repairNumPredict: 900,
    repairTimeoutMs: 35_000,
  });

  try {
    await supabase.from("plan_step_details").upsert({
      plan_id: plan_id.trim(),
      step_key: step_key.trim(),
      details_json: deep,
      model: env.SMART_MODEL,
    });
  } catch {
    // ignore if table doesn't exist yet
  }

  return new Response(
    JSON.stringify({
      mode: "deep_dive",
      plan_id: plan_id.trim(),
      step_key: step_key.trim(),
      model_used: env.SMART_MODEL,
      deep_dive: deep,
      build_marker: env.BUILD_MARKER,
    }),
    { status: 200, headers: env.JSON_HEADERS },
  );
}

// ============================================================
// STREAM HANDLER (SSE)
// ============================================================

export async function handleDeepDiveStream(ctx: Ctx, body: DeepDiveStreamBody): Promise<Response> {
  const { supabase, env } = ctx;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sseEvent(event, data)));

      (async () => {
        try {
          send("status", { phase: "start", build_marker: env.BUILD_MARKER });

          const plan_id = body.plan_id?.trim();
          const step_key = body.step_key?.trim();

          if (!plan_id || !step_key) {
            send("error", { error: "plan_id and step_key are required" });
            controller.close();
            return;
          }

          send("status", { phase: "db_fetch_plan" });
          const { data: plan, error: planFetchErr } = await supabase
            .from("plans")
            .select("id, company_name, company_title, short_description, long_description, person_name")
            .eq("id", plan_id)
            .single();

          if (planFetchErr || !plan) {
            send("error", { error: "Plan not found", detail: planFetchErr });
            controller.close();
            return;
          }

          send("status", { phase: "db_fetch_step" });
          const { data: step, error: stepFetchErr } = await supabase
            .from("plan_steps")
            .select("step_key, title, details, success_criteria, priority, estimated_minutes")
            .eq("plan_id", plan_id)
            .eq("step_key", step_key)
            .single();

          if (stepFetchErr || !step) {
            send("error", { error: "Step not found", detail: stepFetchErr });
            controller.close();
            return;
          }

          // You can optionally emit the step metadata so the UI can render the header instantly:
          send("status", {
            phase: "context_ready",
            plan_id,
            step_key,
            step_title: step.title,
            company_name: plan.company_name,
          });

          const prompt = `Return ONLY valid MINIFIED JSON (single line).

Create a detailed playbook for completing this onboarding step.

Return JSON with keys:
{"step_key":"${step_key}","summary":"...","why_it_matters":"...","prerequisites":["..."],"sub_tasks":[{"title":"...","acceptance_criteria":"...","estimated_minutes":NN}],"pitfalls":["..."],"questions_to_answer":["..."],"next_action":"..."}

Rules:
- step_key MUST be exactly "${step_key}".
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

          send("status", { phase: "model_call_start", model: env.SMART_MODEL });

          const deepRes = await callJSONStream({
            ollamaUrl: env.OLLAMA_URL,
            model: env.SMART_MODEL,
            prompt,
            num_predict: 1200,
            timeoutMs: 80_000,
            repairModel: env.REPAIR_MODEL,
            repairNumPredict: 900,
            repairTimeoutMs: 35_000,
            onToken: (delta) => {
              // Ignore pure whitespace chunks to reduce spam and choppiness
              if (!delta || delta.trim().length === 0) return;
              send("token", { scope: "deep_dive", delta });
            },
          });

          send("status", { phase: "model_call_done" });

          // Persist (best effort)
          try {
            send("status", { phase: "db_upsert_details" });
            await supabase.from("plan_step_details").upsert({
              plan_id,
              step_key,
              details_json: deepRes.parsed,
              model: env.SMART_MODEL,
            });
          } catch {
            // ignore if table doesn't exist
          }

          send("done", {
            mode: "deep_dive_stream",
            plan_id,
            step_key,
            model_used: env.SMART_MODEL,
            deep_dive: deepRes.parsed,
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
