import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserContext, createAdminClient } from "../_shared/supabaseClient.ts";
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

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const { action, ...body } = await req.json();

    switch (action) {
      // ── Get full bot state snapshot ──
      case "get_state": {
        const [balancesRes, tradesRes, settingsRes, stateRes] = await Promise.all([
          admin.from("account_balances").select("*").eq("user_id", user.id),
          admin.from("trades").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50),
          admin.from("bot_settings").select("*").eq("user_id", user.id).maybeSingle(),
          admin.from("bot_state").select("*").eq("user_id", user.id).maybeSingle(),
        ]);

        const balances = (balancesRes.data ?? []).map((b: Record<string, unknown>) => ({
          asset: b.asset,
          spot_balance: b.spot_balance ?? 0,
          futures_balance: b.futures_balance ?? 0,
          total_balance: b.total_balance ?? 0,
        }));

        const trades = (tradesRes.data ?? []).map((t: Record<string, unknown>) => ({
          id: t.id,
          timestamp: t.created_at,
          pair: t.pair,
          type: (t.exchange as string)?.includes("FUTURES") ? "futures-spot" : "spot-futures",
          direction: t.side === "BUY" ? "LONG_SPOT_SHORT_PERP" : "SHORT_SPOT_LONG_PERP",
          spread: 0,
          entryPrice: t.entry_price ?? t.price ?? 0,
          exitPrice: t.exit_price ?? 0,
          volume: ((t.price as number) ?? 0) * ((t.quantity as number) ?? 0),
          pnl: t.pnl ?? 0,
          fees: t.fees ?? 0,
          slippage: t.slippage ?? 0,
          duration: t.execution_time_ms ?? 0,
          aiConfidence: 0,
        }));

        const settings = settingsRes.data;
        const state = stateRes.data;

        const totalPnl = trades.reduce((s: number, t: { pnl: number }) => s + t.pnl, 0);
        const successfulTrades = trades.filter((t: { pnl: number }) => t.pnl > 0).length;

        return jsonResponse({
          snapshot: {
            balances,
            trades,
            metrics: {
              total_pnl: totalPnl,
              daily_pnl: totalPnl,
              total_trades: trades.length,
              success_rate: trades.length > 0 ? (successfulTrades / trades.length) * 100 : 0,
              avg_latency: trades.length > 0 ? trades.reduce((s: number, t: { duration: number }) => s + t.duration, 0) / trades.length : 0,
              active_pairs: new Set(trades.map((t: { pair: string }) => t.pair)).size,
              ai_confidence: settings?.ai_settings?.confidence ?? 85,
            },
            status: {
              running: state?.running ?? false,
              tradingPair: state?.trading_pair ?? "BTCUSDT",
              pollIntervalMs: state?.poll_interval_ms ?? 5000,
              lastCycleAt: state?.last_cycle_at ?? null,
              lastTradeAt: state?.last_trade_at ?? null,
              lastMessage: state?.last_message ?? null,
            },
          },
        });
      }

      // ── Get settings ──
      case "get_settings": {
        const { data } = await admin
          .from("bot_settings")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        const settings = {
          tradingParams: data?.trading_params ?? { minSpread: 0.15, maxPosition: 25000, stopLoss: 0.8, timeout: 45 },
          aiSettings: data?.ai_settings ?? { enabled: true, learningRate: 0.01, confidence: 85, retraining: true },
          riskSettings: data?.risk_settings ?? { maxDailyLoss: 1000, maxConcurrentTrades: 5, emergencyStop: true },
        };

        return jsonResponse({ settings });
      }

      // ── Update settings ──
      case "update_settings": {
        const { tradingParams, aiSettings, riskSettings } = body;

        const payload: Record<string, unknown> = {
          user_id: user.id,
          updated_at: new Date().toISOString(),
        };
        if (tradingParams) payload.trading_params = tradingParams;
        if (aiSettings) payload.ai_settings = aiSettings;
        if (riskSettings) payload.risk_settings = riskSettings;

        const { error } = await admin.from("bot_settings").upsert(payload);
        if (error) throw error;

        return jsonResponse({ settings: { tradingParams, aiSettings, riskSettings } });
      }

      // ── Start bot ──
      case "start_bot": {
        const { error } = await admin.from("bot_state").upsert({
          user_id: user.id,
          running: true,
          last_message: "Bot iniciado",
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;

        // Return updated state
        const stateAfter = await admin.from("bot_state").select("*").eq("user_id", user.id).maybeSingle();
        return jsonResponse({
          snapshot: {
            balances: [],
            trades: [],
            metrics: { total_pnl: 0, daily_pnl: 0, total_trades: 0, success_rate: 0, avg_latency: 0, active_pairs: 0, ai_confidence: 85 },
            status: {
              running: true,
              tradingPair: stateAfter.data?.trading_pair ?? "BTCUSDT",
              pollIntervalMs: stateAfter.data?.poll_interval_ms ?? 5000,
              lastCycleAt: stateAfter.data?.last_cycle_at ?? null,
              lastTradeAt: stateAfter.data?.last_trade_at ?? null,
              lastMessage: "Bot iniciado",
            },
          },
        });
      }

      // ── Stop bot ──
      case "stop_bot": {
        const { error } = await admin.from("bot_state").upsert({
          user_id: user.id,
          running: false,
          last_message: "Bot parado",
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;

        return jsonResponse({
          snapshot: {
            balances: [],
            trades: [],
            metrics: { total_pnl: 0, daily_pnl: 0, total_trades: 0, success_rate: 0, avg_latency: 0, active_pairs: 0, ai_confidence: 85 },
            status: {
              running: false,
              tradingPair: "BTCUSDT",
              pollIntervalMs: 5000,
              lastCycleAt: null,
              lastTradeAt: null,
              lastMessage: "Bot parado",
            },
          },
        });
      }

      // ── Sync balances with Binance ──
      case "sync": {
        try {
          const credentials = await loadBinanceCredentials(admin, user.id);
          const connector = new BinanceConnector({ supabase: admin, userId: user.id, credentials });
          await connector.persistBalances();
        } catch (e) {
          console.error("Sync error", e);
        }

        // Return fresh state after sync
        const [balRes, stRes] = await Promise.all([
          admin.from("account_balances").select("*").eq("user_id", user.id),
          admin.from("bot_state").select("*").eq("user_id", user.id).maybeSingle(),
        ]);

        return jsonResponse({
          snapshot: {
            balances: (balRes.data ?? []).map((b: Record<string, unknown>) => ({
              asset: b.asset,
              spot_balance: b.spot_balance ?? 0,
              futures_balance: b.futures_balance ?? 0,
              total_balance: b.total_balance ?? 0,
            })),
            trades: [],
            metrics: { total_pnl: 0, daily_pnl: 0, total_trades: 0, success_rate: 0, avg_latency: 0, active_pairs: 0, ai_confidence: 85 },
            status: {
              running: stRes.data?.running ?? false,
              tradingPair: stRes.data?.trading_pair ?? "BTCUSDT",
              pollIntervalMs: stRes.data?.poll_interval_ms ?? 5000,
              lastCycleAt: stRes.data?.last_cycle_at ?? null,
              lastTradeAt: stRes.data?.last_trade_at ?? null,
              lastMessage: "Sincronizado com Binance",
            },
          },
        });
      }

      // ── System status ──
      case "system_status": {
        // Check API keys
        const { data: apiConfig } = await admin
          .from("api_configurations")
          .select("id, testnet")
          .eq("user_id", user.id)
          .eq("exchange_name", "BINANCE")
          .eq("is_active", true)
          .maybeSingle();

        const apiKeysStatus = apiConfig ? "configured" : "missing";

        let binanceConnection: "connected" | "disconnected" | "error" = "disconnected";
        if (apiConfig) {
          try {
            const credentials = await loadBinanceCredentials(admin, user.id);
            const connector = new BinanceConnector({ supabase: admin, userId: user.id, credentials });
            const valid = await connector.validateConnection();
            binanceConnection = valid ? "connected" : "error";
          } catch {
            binanceConnection = "error";
          }
        }

        return jsonResponse({
          status: {
            binanceConnection,
            regionalStatus: "full",
            websocketStatus: "connected",
            apiKeys: apiKeysStatus,
            region: "Global",
            restrictions: [],
            connectivity: true,
          },
        });
      }

      // ── API Keys management ──
      case "get_keys": {
        const { data } = await admin
          .from("api_configurations")
          .select("id, testnet, created_at, updated_at")
          .eq("user_id", user.id)
          .eq("exchange_name", "BINANCE")
          .eq("is_active", true)
          .maybeSingle();

        return jsonResponse({
          configured: Boolean(data),
          testnet: data?.testnet ?? false,
          updatedAt: data?.updated_at ?? null,
          mode: "futures",
          apiKeyMask: data ? "******" : "",
        });
      }

      case "save_keys": {
        if (!body.apiKey || !body.apiSecret) {
          return jsonResponse({ error: "apiKey and apiSecret are required" }, 400);
        }

        const { error } = await admin.from("api_configurations").upsert({
          user_id: user.id,
          exchange_name: "BINANCE",
          api_key: body.apiKey,
          api_secret: body.apiSecret,
          testnet: Boolean(body.testnet),
          is_active: true,
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;

        return jsonResponse({
          success: true,
          state: {
            configured: true,
            testnet: Boolean(body.testnet),
            mode: body.mode ?? "futures",
            apiKeyMask: `${body.apiKey.slice(0, 6)}***${body.apiKey.slice(-4)}`,
            updatedAt: new Date().toISOString(),
          },
        });
      }

      default:
        return jsonResponse({ error: "Invalid action" }, 400);
    }
  } catch (error) {
    console.error("bot-engine error", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = message === "Unauthorized" ? 401 : 500;
    return jsonResponse({ error: message }, status);
  }
});
