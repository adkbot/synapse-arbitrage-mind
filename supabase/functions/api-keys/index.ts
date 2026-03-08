import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createAdminClient, requireUserContext } from "../_shared/supabaseClient.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const admin = createAdminClient();

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user } = await requireUserContext(req);

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const body = await req.json();
    const action = body?.action;

    switch (action) {
      case "get": {
        const { data, error } = await admin
          .from("api_configurations")
          .select("id, testnet, created_at, updated_at")
          .eq("user_id", user.id)
          .eq("exchange_name", "BINANCE")
          .eq("is_active", true)
          .maybeSingle();

        if (error) {
          throw error;
        }

        return jsonResponse({
          configured: Boolean(data),
          testnet: data?.testnet ?? false,
          updatedAt: data?.updated_at ?? null,
        });
      }
      case "save": {
        if (!body.apiKey || !body.apiSecret) {
          return jsonResponse({ error: "apiKey and apiSecret are required" }, 400);
        }

        const payload = {
          user_id: user.id,
          exchange_name: "BINANCE",
          api_key: body.apiKey,
          api_secret: body.apiSecret,
          testnet: Boolean(body.testnet),
          is_active: true,
          updated_at: new Date().toISOString(),
        };

        const { error } = await admin.from("api_configurations").upsert(payload);
        if (error) {
          throw error;
        }

        return jsonResponse({ success: true });
      }
      case "deactivate": {
        const { error } = await admin
          .from("api_configurations")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("user_id", user.id)
          .eq("exchange_name", "BINANCE");

        if (error) {
          throw error;
        }

        return jsonResponse({ success: true });
      }
      default:
        return jsonResponse({ error: "Invalid action" }, 400);
    }
  } catch (error) {
    console.error("api-keys error", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = message === "Unauthorized" ? 401 : 500;
    return jsonResponse({ error: message }, status);
  }
});
