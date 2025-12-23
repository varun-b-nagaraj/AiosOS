import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

import type { Body, Ctx } from "./shared.ts";
import { handleGeneratePlan, handleGeneratePlanStream } from "./generate_plan.ts";
import { handleDeepDive, handleDeepDiveStream } from "./deep_dive.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const DEV_USER_ID = "00000000-0000-0000-0000-000000000000";
const BUILD_MARKER = "ai-generate-plan stepwise-dynamicN 2025-12-23-03";

const MIN_STEPS = 3;
const MAX_STEPS = 10;

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

    const ctx: Ctx = {
      supabase,
      env: {
        JSON_HEADERS,
        DEV_USER_ID,
        BUILD_MARKER,
        MIN_STEPS,
        MAX_STEPS,
        OLLAMA_URL,
        FAST_MODEL,
        SMART_MODEL,
        REPAIR_MODEL,
      },
    };

    switch (body.mode) {
      case "generate_plan":
        return await handleGeneratePlan(ctx, body);

      case "generate_plan_stream":
        return await handleGeneratePlanStream(ctx, body);

      case "deep_dive":
        return await handleDeepDive(ctx, body);
      case "deep_dive_stream":
        return await handleDeepDiveStream(ctx, body);

      default:
        return new Response(
          JSON.stringify({ error: "Unknown mode. Use 'generate_plan' | 'generate_plan_stream' | 'deep_dive'", build_marker: BUILD_MARKER }),
          { status: 400, headers: JSON_HEADERS },
        );
    }
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
