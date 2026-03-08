import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireUserContext } from "../_shared/supabaseClient.ts";
import { BinanceConnector, loadBinanceCredentials } from "../_shared/binance.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type MarketDataRow = {
  symbol: string | null;
  bid_price: number | null;
  ask_price: number | null;
  spread: number | null;
  volume_24h?: number | null;
};
type BalanceRow = {
  asset: string | null;
  total_balance: number | null;
};

interface TradeOpportunity {
  pair: string;
  bidPrice: number;
  askPrice: number;
  spread: number;
  volume: number;
  estimatedProfit: number;
  confidence: number;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class TradingEngine {
  constructor(
    private supabase: SupabaseClient,
    private userId: string,
    private binance: BinanceConnector,
  ) {}

  async findArbitrageOpportunities(): Promise<TradeOpportunity[]> {
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const { data: rawMarketData, error } = await this.supabase
      .from("market_data_cache")
      .select("symbol, bid_price, ask_price, spread, volume_24h, updated_at")
      .gte("updated_at", fiveSecondsAgo);

    if (error || !rawMarketData) {
      console.error("Market data fetch error", error);
      return [];
    }

    const marketData = rawMarketData as MarketDataRow[];
    const grouped = new Map<string, MarketDataRow[]>();

    for (const row of marketData) {
      if (!row.symbol) continue;
      const entries = grouped.get(row.symbol) ?? [];
      entries.push(row);
      grouped.set(row.symbol, entries);
    }

    const opportunities: TradeOpportunity[] = [];

    for (const [pair, entries] of grouped.entries()) {
      if (entries.length < 2) continue;

      const bidCandidates = entries.map((entry) => Number(entry.bid_price ?? 0));
      const askCandidates = entries.map((entry) => Number(entry.ask_price ?? 0));
      const bestBid = Math.max(...bidCandidates);
      const bestAsk = Math.min(...askCandidates);

      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= bestAsk) {
        continue;
      }

      const spread = ((bestBid - bestAsk) / bestAsk) * 100;
      if (spread <= 0.05) continue;

      const volumeValues = entries.map((entry) => Number(entry.volume_24h ?? 0));
      const volume = volumeValues.length > 0 ? Math.min(...volumeValues.filter((v) => v > 0)) || 0 : 0;
      const estimatedProfit = (bestBid - bestAsk) * Math.min(volume, 1);

      opportunities.push({
        pair,
        bidPrice: bestBid,
        askPrice: bestAsk,
        spread,
        volume,
        estimatedProfit,
        confidence: this.calculateConfidence(spread, volume),
      });
    }

    return opportunities.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
  }

  private calculateConfidence(spread: number, volume: number): number {
    const spreadScore = Math.min(spread / 0.5, 1);
    const volumeScore = Math.min(volume / 1000, 1);
    return (spreadScore * 0.6 + volumeScore * 0.4) * 100;
  }

  async executeTrade(opportunity: TradeOpportunity): Promise<boolean> {
    try {
      const { data: rawBalances, error: balanceError } = await this.supabase
        .from("account_balances")
        .select("asset, total_balance")
        .eq("user_id", this.userId);

      if (balanceError) {
        throw new Error(balanceError.message);
      }

      const balances = (rawBalances ?? []) as BalanceRow[];
      const usdtBalance = balances.find((balance) => balance.asset === "USDT");

      if (!usdtBalance || Number(usdtBalance.total_balance ?? 0) <= 0) {
        throw new Error("No USDT balance available for trading");
      }

      const orderQty = Math.min(opportunity.volume, Number(usdtBalance.total_balance));
      if (orderQty <= 0) {
        throw new Error("Calculated order quantity is zero");
      }

      await this.binance.placeOrder({
        market: "spot",
        symbol: opportunity.pair,
        side: "BUY",
        type: "MARKET",
        quantity: orderQty,
      });

      await this.binance.placeOrder({
        market: "futures",
        symbol: opportunity.pair,
        side: "SELL",
        type: "MARKET",
        quantity: orderQty,
        reduceOnly: false,
        positionSide: "SHORT",
      });

      await this.binance.persistBalances();
      return true;
    } catch (error) {
      console.error("executeTrade error", error);
      return false;
    }
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const context = await requireUserContext(req);
    const credentials = await loadBinanceCredentials(context.admin, context.user.id);
    const connector = new BinanceConnector({ supabase: context.admin, userId: context.user.id, credentials });
    const engine = new TradingEngine(context.admin, context.user.id, connector);

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const payload = await req.json();
    const action = payload?.action;

    if (action === "find_opportunities") {
      const opportunities = await engine.findArbitrageOpportunities();
      return jsonResponse({ opportunities });
    }

    if (action === "execute_trade") {
      if (!payload?.opportunity) {
        return jsonResponse({ error: "Missing opportunity" }, 400);
      }
      const success = await engine.executeTrade(payload.opportunity as TradeOpportunity);
      return jsonResponse({ success });
    }

    return jsonResponse({ error: "Invalid request" }, 400);
  } catch (error) {
    console.error("trading-engine error", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = message === "Unauthorized" ? 401 : 500;
    return jsonResponse({ error: message }, status);
  }
});
