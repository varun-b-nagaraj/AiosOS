import type { Ctx } from "./shared.ts";
import { sseHeaders, sseEvent } from "./shared.ts";

export type ApplyPlanBody = {
  mode: "apply_plan";
  stream?: boolean; // default true in router (body.stream !== false)

  plan_id: string;

  // Optional operational context
  company_id?: string;
  owner_user_id?: string; // who owns the tasks
  start_date?: string; // YYYY-MM-DD
  cadence_days?: number; // spacing between tasks (default 2)
  project_key?: string; // lightweight grouping key
  labels?: string[]; // tags/labels (string) for your UI

  // Safety / preview
  dry_run?: boolean;
};

type PlanRow = {
  id: string;
  user_id: string | null;
  company_name: string | null;
  company_title: string | null;
  short_description: string | null;
  long_description: string | null;
};

type StepRow = {
  step_key: string;
  order_index: number;
  title: string;
  details: string;
  success_criteria: string;
  priority: "low" | "medium" | "high";
  estimated_minutes: number;
};

function todayYYYYMMDD(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysYYYYMMDD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeCadence(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 2;
  return Math.max(1, Math.min(14, Math.trunc(v)));
}

function taskTitleFromStep(step: StepRow) {
  // Keep it short and action-oriented
  return step.title?.trim() ? step.title.trim() : `Complete ${step.step_key}`;
}

function taskDescriptionFromStep(step: StepRow) {
  const lines = [];
  if (step.details?.trim()) lines.push(`Details: ${step.details.trim()}`);
  if (step.success_criteria?.trim()) lines.push(`Success: ${step.success_criteria.trim()}`);
  lines.push(`Priority: ${step.priority}`);
  lines.push(`Estimate: ${step.estimated_minutes} minutes`);
  return lines.join("\n");
}

/**
 * Adapt these fields to your Atomic CRM task schema.
 * This shape is intentionally minimal and common.
 */
function buildTaskInsert(input: {
  plan_id: string;
  step: StepRow;
  due_ymd: string;
  created_by: string;
  owner_user_id: string;
  company_id?: string | null;
  project_key?: string | null;
  labels?: string[];
}) {
  const {
    plan_id,
    step,
    due_ymd,
    created_by,
    owner_user_id,
    company_id,
    project_key,
    labels,
  } = input;

  return {
    // existing required columns
    company_id: company_id ?? null,
    title: step.title,
    status: "todo",
    due_at: `${due_ymd}T09:00:00.000Z`,
    created_by: created_by ?? owner_user_id,

    // new Option A columns
    owner_user_id,
    details: step.details,
    success_criteria: step.success_criteria,
    priority: step.priority,
    estimated_minutes: step.estimated_minutes,
    plan_id,
    step_key: step.step_key,
    project_key: project_key ?? `plan:${plan_id}`,
    labels: labels ?? [],
  };
}

export async function handleApplyPlan(ctx: Ctx, body: ApplyPlanBody): Promise<Response> {
  const { supabase, env } = ctx;

  const plan_id = body.plan_id?.trim();
  if (!plan_id) {
    return new Response(JSON.stringify({ error: "plan_id is required", build_marker: env.BUILD_MARKER }), {
      status: 400,
      headers: env.JSON_HEADERS,
    });
  }

  const cadence_days = normalizeCadence(body.cadence_days);
  const start_date = (body.start_date?.trim() || todayYYYYMMDD());
  const dry_run = body.dry_run === true;

  const { data: plan, error: planErr } = await supabase
    .from("plans")
    .select("id,user_id,company_name,company_title,short_description,long_description")
    .eq("id", plan_id)
    .single<PlanRow>();

  if (planErr || !plan) {
    return new Response(JSON.stringify({ error: "Plan not found", detail: planErr, build_marker: env.BUILD_MARKER }), {
      status: 404,
      headers: env.JSON_HEADERS,
    });
  }

  const { data: steps, error: stepsErr } = await supabase
    .from("plan_steps")
    .select("step_key,order_index,title,details,success_criteria,priority,estimated_minutes")
    .eq("plan_id", plan_id)
    .order("order_index", { ascending: true })
    .returns<StepRow[]>();

  if (stepsErr || !steps || steps.length === 0) {
    return new Response(JSON.stringify({ error: "No plan steps found", detail: stepsErr, build_marker: env.BUILD_MARKER }), {
      status: 404,
      headers: env.JSON_HEADERS,
    });
  }

  // Determine owner: prefer explicit owner_user_id, else plan.user_id.
  const owner_user_id = (body.owner_user_id?.trim() || plan.user_id || "").trim();
  if (!owner_user_id) {
    return new Response(
      JSON.stringify({ error: "owner_user_id is required (or plan.user_id must be set)", build_marker: env.BUILD_MARKER }),
      { status: 400, headers: env.JSON_HEADERS },
    );
  }

  const company_id = body.company_id?.trim() || null;
  const project_key = body.project_key?.trim() || `plan:${plan_id}`;
  const labels = Array.isArray(body.labels) ? body.labels.map(String) : ["ai-plan", "onboarding"];
  const created_by = owner_user_id; // simplest: creator = owner
  const existing = await supabase.from("tasks").select("id").eq("plan_id", plan_id).returns<{ id: string }[]>();
  if (existing.error) {
    return new Response(
      JSON.stringify({ error: "Failed to check existing tasks", detail: existing.error, build_marker: env.BUILD_MARKER }),
      { status: 500, headers: env.JSON_HEADERS },
    );
  }
  if (existing.data && existing.data.length > 0) {
    return new Response(
      JSON.stringify({
        mode: "apply_plan",
        plan_id,
        company_id,
        owner_user_id,
        project_key,
        existing_task_ids: existing.data.map((t) => t.id),
        created_task_ids: [],
        created_note_ids: [],
        created_widget_ids: [],
        build_marker: env.BUILD_MARKER,
      }),
      { status: 200, headers: env.JSON_HEADERS },
    );
  }

  const tasksToCreate = steps.map((s, idx) => {
    const due_ymd = addDaysYYYYMMDD(start_date, idx * cadence_days);

    return buildTaskInsert({
      plan_id,
      step: s,
      due_ymd, // FIX
      created_by, // FIX
      owner_user_id,
      company_id: company_id ?? null,
      project_key,
      labels,
    });
  });

  if (dry_run) {
    return new Response(
      JSON.stringify({
        mode: "apply_plan",
        dry_run: true,
        plan_id,
        owner_user_id,
        company_id,
        project_key,
        cadence_days,
        start_date,
        tasks_preview: tasksToCreate,
        build_marker: env.BUILD_MARKER,
      }),
      { status: 200, headers: env.JSON_HEADERS },
    );
  }

  // Insert tasks
  if (!tasksToCreate.length) {
    return new Response(JSON.stringify({ error: "No steps to apply", build_marker: env.BUILD_MARKER }), {
      status: 400,
      headers: env.JSON_HEADERS,
    });
  }

  if (!tasksToCreate[0]?.created_by) {
    ctx.send?.("error", { error: "created_by missing in tasksToCreate[0]" });
    return new Response(JSON.stringify({ error: "created_by missing", build_marker: env.BUILD_MARKER }), {
      status: 500,
      headers: env.JSON_HEADERS,
    });
  }

  const { data: createdTasks, error: taskErr } = await supabase
    .from("tasks")
    .insert(tasksToCreate)
    .select("id")
    .returns<{ id: string }[]>();

  if (taskErr) {
    return new Response(JSON.stringify({ error: "Failed to create tasks", detail: taskErr, build_marker: env.BUILD_MARKER }), {
      status: 500,
      headers: env.JSON_HEADERS,
    });
  }

  const created_task_ids = (createdTasks ?? []).map((t) => t.id);

  // Optional: create an audit note (best effort)
  const created_note_ids: string[] = [];
  try {
    const noteBody =
      `Applied plan to tasks.\n` +
      `Plan: ${plan.company_name ?? ""} (${plan.company_title ?? ""})\n` +
      `Tasks created: ${created_task_ids.length}\n` +
      `Project: ${project_key}\n` +
      `Labels: ${labels.join(", ")}`;

    const { data: note, error: noteErr } = await supabase
      .from("notes")
      .insert({
        title: "Plan applied",
        body: noteBody,
        owner_user_id,
        company_id,
        source: "ai_plan_apply",
        plan_id,
      })
      .select("id")
      .single<{ id: string }>();

    if (!noteErr && note?.id) created_note_ids.push(note.id);
  } catch {
    // ignore
  }

  // Optional: create default dashboard widgets (best effort)
  const created_widget_ids: string[] = [];
  try {
    const widgets = [
      { kind: "tasks_due_soon", config: { days: 7, project_key }, title: "Tasks due soon" },
      { kind: "plan_progress", config: { plan_id }, title: "Plan progress" },
    ];

    const { data: w, error: wErr } = await supabase
      .from("dashboard_widgets")
      .insert(
        widgets.map((x) => ({
          title: x.title,
          kind: x.kind,
          config: x.config,
          owner_user_id,
          company_id,
          source: "ai_plan_apply",
        })),
      )
      .select("id")
      .returns<{ id: string }[]>();

    if (!wErr && w) created_widget_ids.push(...w.map((x) => x.id));
  } catch {
    // ignore
  }

  return new Response(
    JSON.stringify({
      mode: "apply_plan",
      plan_id,
      company_id,
      owner_user_id,
      project_key,
      created_task_ids,
      created_note_ids,
      created_widget_ids,
      build_marker: env.BUILD_MARKER,
    }),
    { status: 200, headers: env.JSON_HEADERS },
  );
}

// =====================
// STREAMING VERSION
// =====================
export async function handleApplyPlanStream(ctx: Ctx, body: ApplyPlanBody): Promise<Response> {
  const { supabase, env } = ctx;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sseEvent(event, data)));

      (async () => {
        try {
          send("status", { phase: "start", build_marker: env.BUILD_MARKER });

          const plan_id = body.plan_id?.trim();
          if (!plan_id) {
            send("error", { error: "plan_id is required" });
            controller.close();
            return;
          }

          const cadence_days = normalizeCadence(body.cadence_days);
          const start_date = (body.start_date?.trim() || todayYYYYMMDD());
          const dry_run = body.dry_run === true;

          send("status", { phase: "db_fetch_plan" });
          const { data: plan, error: planErr } = await supabase
            .from("plans")
            .select("id,user_id,company_name,company_title,short_description,long_description")
            .eq("id", plan_id)
            .single<PlanRow>();

          if (planErr || !plan) {
            send("error", { error: "Plan not found", detail: planErr });
            controller.close();
            return;
          }

          send("status", { phase: "db_fetch_steps" });
          const { data: steps, error: stepsErr } = await supabase
            .from("plan_steps")
            .select("step_key,order_index,title,details,success_criteria,priority,estimated_minutes")
            .eq("plan_id", plan_id)
            .order("order_index", { ascending: true })
            .returns<StepRow[]>();

          if (stepsErr || !steps || steps.length === 0) {
            send("error", { error: "No plan steps found", detail: stepsErr });
            controller.close();
            return;
          }

          const owner_user_id = (body.owner_user_id?.trim() || plan.user_id || "").trim();
          if (!owner_user_id) {
            send("error", { error: "owner_user_id is required (or plan.user_id must be set)" });
            controller.close();
            return;
          }

          const company_id = body.company_id?.trim() || null;
          const project_key = body.project_key?.trim() || `plan:${plan_id}`;
          const labels = Array.isArray(body.labels) ? body.labels.map(String) : ["ai-plan", "onboarding"];
          const created_by = owner_user_id; // simplest: creator = owner

          send("status", { phase: "db_check_existing_tasks" });
          const existing = await supabase.from("tasks").select("id").eq("plan_id", plan_id).returns<{ id: string }[]>();
          if (existing.error) {
            send("error", { error: "Failed to check existing tasks", detail: existing.error });
            controller.close();
            return;
          }
          if (existing.data && existing.data.length > 0) {
            send("status", { phase: "tasks_existing", count: existing.data.length });
            send("done", {
              mode: "apply_plan",
              plan_id,
              company_id,
              owner_user_id,
              project_key,
              existing_task_ids: existing.data.map((t) => t.id),
              created_task_ids: [],
              created_note_ids: [],
              created_widget_ids: [],
              build_marker: env.BUILD_MARKER,
            });
            controller.close();
            return;
          }

          send("status", {
            phase: "context_ready",
            plan_id,
            owner_user_id,
            company_id,
            project_key,
            cadence_days,
            start_date,
            step_count: steps.length,
          });

          const tasksToCreate = steps.map((s, idx) => {
            const due_ymd = addDaysYYYYMMDD(start_date, idx * cadence_days);
            return buildTaskInsert({
              plan_id,
              step: s,
              due_ymd,
              created_by,
              owner_user_id,
              company_id: company_id ?? null,
              project_key,
              labels,
            });
          });

          if (dry_run) {
            send("done", {
              mode: "apply_plan",
              dry_run: true,
              plan_id,
              owner_user_id,
              company_id,
              project_key,
              tasks_preview: tasksToCreate,
              build_marker: env.BUILD_MARKER,
            });
            controller.close();
            return;
          }

          send("status", { phase: "db_insert_tasks" });
          const { data: createdTasks, error: taskErr } = await supabase
            .from("tasks")
            .insert(tasksToCreate)
            .select("id")
            .returns<{ id: string }[]>();

          if (taskErr) {
            send("error", { error: "Failed to create tasks", detail: taskErr });
            controller.close();
            return;
          }

          const created_task_ids = (createdTasks ?? []).map((t) => t.id);
          send("status", { phase: "tasks_created", count: created_task_ids.length });

          const created_note_ids: string[] = [];
          try {
            send("status", { phase: "db_insert_note" });
            const noteBody =
              `Applied plan to tasks.\n` +
              `Plan: ${plan.company_name ?? ""} (${plan.company_title ?? ""})\n` +
              `Tasks created: ${created_task_ids.length}\n` +
              `Project: ${project_key}\n` +
              `Labels: ${labels.join(", ")}`;

            const { data: note, error: noteErr } = await supabase
              .from("notes")
              .insert({
                title: "Plan applied",
                body: noteBody,
                owner_user_id,
                company_id,
                source: "ai_plan_apply",
                plan_id,
              })
              .select("id")
              .single<{ id: string }>();

            if (!noteErr && note?.id) created_note_ids.push(note.id);
          } catch {
            // ignore
          }

          const created_widget_ids: string[] = [];
          try {
            send("status", { phase: "db_insert_widgets" });
            const widgets = [
              { kind: "tasks_due_soon", config: { days: 7, project_key }, title: "Tasks due soon" },
              { kind: "plan_progress", config: { plan_id }, title: "Plan progress" },
            ];

            const { data: w, error: wErr } = await supabase
              .from("dashboard_widgets")
              .insert(
                widgets.map((x) => ({
                  title: x.title,
                  kind: x.kind,
                  config: x.config,
                  owner_user_id,
                  company_id,
                  source: "ai_plan_apply",
                })),
              )
              .select("id")
              .returns<{ id: string }[]>();

            if (!wErr && w) created_widget_ids.push(...w.map((x) => x.id));
          } catch {
            // ignore
          }

          send("done", {
            mode: "apply_plan",
            plan_id,
            company_id,
            owner_user_id,
            project_key,
            created_task_ids,
            created_note_ids,
            created_widget_ids,
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
