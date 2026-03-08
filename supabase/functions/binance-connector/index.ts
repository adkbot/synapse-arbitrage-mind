import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserContext } from "../_shared/supabaseClient.ts";
import { BinanceConnector, loadBinanceCredentials } from "../_shared/binance.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { admin, user } = await requireUserContext(req);
    const credentials = await loadBinanceCredentials(admin, user.id);
    const connector = new BinanceConnector({ supabase: admin, userId: user.id, credentials });

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const { action, ...body } = await req.json();

    switch (action) {
      case "validate_connection": {
        const valid = await connector.validateConnection();
        return jsonResponse({ success: valid, valid });
      }
      case "sync_balances":
      case "get_balances": {
        const totals = await connector.persistBalances();
        return jsonResponse({ success: true, totals });
      }
      case "get_orderbook": {
        if (!body.symbol) {
          return jsonResponse({ success: false, error: "Missing symbol" }, 400);
        }
        const orderbook = await connector.getOrderBook(body.symbol);
        return jsonResponse({ success: true, orderbook });
      }
      case "place_order": {
        const required = ["symbol", "side", "type", "quantity"] as const;
        for (const key of required) {
          if (!(key in body)) {
            return jsonResponse({ success: false, error: `Missing ${key}` }, 400);
          }
        }

        const reduceOnly = typeof body.reduceOnly === "boolean"
          ? body.reduceOnly
          : body.reduceOnly === "true"
            ? true
            : body.reduceOnly === "false"
              ? false
              : undefined;

        const order = await connector.placeOrder({
          symbol: body.symbol,
          side: body.side,
          type: body.type,
          quantity: Number(body.quantity),
          price: body.price !== undefined ? Number(body.price) : undefined,
          market: body.market === "futures" ? "futures" : "spot",
          reduceOnly,
          positionSide: body.positionSide,
        });
        return jsonResponse({ success: true, order });
      }
      default:
        return jsonResponse({ success: false, error: "Invalid action" }, 400);
    }
  } catch (error) {
    console.error("binance-connector error", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = message === "Unauthorized" ? 401 : 500;
    return jsonResponse({ success: false, error: message }, status);
  }
});
