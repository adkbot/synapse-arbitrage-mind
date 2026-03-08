import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type SpotBalance = { asset: string; free: number; locked: number };
type FuturesBalance = { asset: string; balance: number };

type OrderParams = {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: number;
  price?: number;
  market?: "spot" | "futures";
  reduceOnly?: boolean;
  positionSide?: "LONG" | "SHORT" | "BOTH";
};

export type Credentials = {
  apiKey: string;
  secretKey: string;
  testnet: boolean;
};

export async function loadBinanceCredentials(admin: SupabaseClient, userId: string): Promise<Credentials> {
  const { data, error } = await admin
    .from("api_configurations")
    .select("api_key, api_secret, testnet")
    .eq("user_id", userId)
    .eq("exchange_name", "BINANCE")
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw new Error("Binance API credentials not configured for this user.");
  }

  return {
    apiKey: data.api_key,
    secretKey: data.api_secret,
    testnet: Boolean(data.testnet),
  };
}

export class BinanceConnector {
  private supabase: SupabaseClient;
  private userId: string;
  private apiKey: string;
  private secretKey: string;
  private spotBaseUrl: string;
  private futuresBaseUrl: string;

  constructor(opts: { supabase: SupabaseClient; userId: string; credentials: Credentials }) {
    this.supabase = opts.supabase;
    this.userId = opts.userId;
    this.apiKey = opts.credentials.apiKey;
    this.secretKey = opts.credentials.secretKey;
    this.spotBaseUrl = opts.credentials.testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
    this.futuresBaseUrl = opts.credentials.testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  }

  private async createSignature(query: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secretKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(query),
    );

    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async signedRequest(
    endpoint: string,
    method: "GET" | "POST",
    params: Record<string, string | number> = {},
    market: "spot" | "futures" = "spot",
  ): Promise<Response> {
    const timestamp = Date.now();
    const composed = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      composed.append(key, String(value));
    }
    composed.append("timestamp", String(timestamp));

    const signature = await this.createSignature(composed.toString());
    composed.append("signature", signature);

    const baseUrl = market === "spot" ? this.spotBaseUrl : this.futuresBaseUrl;
    const query = composed.toString();
    const url = `${baseUrl}${endpoint}${method === "GET" ? `?${query}` : ""}`;

    const init: RequestInit = {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };

    if (method === "POST") {
      init.body = query;
    }

    return await fetch(url, init);
  }

  async validateConnection(): Promise<boolean> {
    try {
      const response = await this.signedRequest("/api/v3/account", "GET");
      if (!response.ok) {
        console.error("Binance validation error", await response.text());
        return false;
      }
      return true;
    } catch (error) {
      console.error("Binance validation exception", error);
      return false;
    }
  }

  async fetchSpotBalances(): Promise<SpotBalance[]> {
    const response = await this.signedRequest("/api/v3/account", "GET");
    if (!response.ok) {
      throw new Error(`Failed to fetch spot balances: ${response.status}`);
    }

    const payload = await response.json();
    const balances = payload?.balances ?? [];

    return balances
      .map((b: { asset: string; free: string; locked: string }) => ({
        asset: b.asset,
        free: Number(b.free ?? 0),
        locked: Number(b.locked ?? 0),
      }))
      .filter((b: SpotBalance) => b.free > 0 || b.locked > 0);
  }

  async fetchFuturesBalances(): Promise<FuturesBalance[]> {
    const response = await this.signedRequest("/fapi/v2/account", "GET", {}, "futures");
    if (!response.ok) {
      throw new Error(`Failed to fetch futures balances: ${response.status}`);
    }

    const payload = await response.json();
    const assets = payload?.assets ?? [];

    return assets
      .map((a: { asset: string; walletBalance: string }) => ({
        asset: a.asset,
        balance: Number(a.walletBalance ?? 0),
      }))
      .filter((a: FuturesBalance) => a.balance > 0);
  }

  async persistBalances(): Promise<{ spot: number; futures: number }> {
    const [spotBalances, futuresBalances] = await Promise.all([
      this.fetchSpotBalances(),
      this.fetchFuturesBalances(),
    ]);

    const assetTotals = new Map<string, { spot: number; futures: number }>();

    for (const balance of spotBalances) {
      const entry = assetTotals.get(balance.asset) ?? { spot: 0, futures: 0 };
      entry.spot += balance.free + balance.locked;
      assetTotals.set(balance.asset, entry);
    }

    for (const balance of futuresBalances) {
      const entry = assetTotals.get(balance.asset) ?? { spot: 0, futures: 0 };
      entry.futures += balance.balance;
      assetTotals.set(balance.asset, entry);
    }

    await this.supabase.from("account_balances").delete().eq("user_id", this.userId);

    if (assetTotals.size > 0) {
      const rows = Array.from(assetTotals.entries()).map(([asset, totals]) => ({
        user_id: this.userId,
        asset,
        spot_balance: totals.spot,
        futures_balance: totals.futures,
        total_balance: totals.spot + totals.futures,
        updated_at: new Date().toISOString(),
      }));

      const { error } = await this.supabase.from("account_balances").insert(rows);
      if (error) {
        console.error("Failed to persist balances", error);
        throw error;
      }
    }

    let totalSpot = 0;
    let totalFutures = 0;
    for (const totals of assetTotals.values()) {
      totalSpot += totals.spot;
      totalFutures += totals.futures;
    }

    return { spot: totalSpot, futures: totalFutures };
  }

  async getOrderBook(symbol: string) {
    const url = `${this.spotBaseUrl}/api/v3/depth?symbol=${symbol}&limit=20`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch order book: ${response.status}`);
    }

    const data = await response.json();

    if (!data?.bids?.length || !data?.asks?.length) {
      return data;
    }

    const bestBid = Number(data.bids[0][0]);
    const bestAsk = Number(data.asks[0][0]);

    const { error } = await this.supabase
      .from("market_data_cache")
      .upsert({
        symbol,
        bid_price: bestBid,
        ask_price: bestAsk,
        spread: bestAsk - bestBid,
        volume_24h: null,
        source: "BINANCE_SPOT",
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error("Market data cache upsert error", error);
    }

    return data;
  }

  async placeOrder(params: OrderParams) {
    const market = params.market ?? "spot";
    const endpoint = market === "spot" ? "/api/v3/order" : "/fapi/v1/order";

    const body: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
    };

    if (params.type === "LIMIT" && params.price !== undefined) {
      body.price = params.price;
      body.timeInForce = "GTC";
    }

    if (market === "futures") {
      if (params.reduceOnly !== undefined) {
        body.reduceOnly = params.reduceOnly ? "true" : "false";
      }
      if (params.positionSide) {
        body.positionSide = params.positionSide;
      }
    }

    const start = Date.now();
    const response = await this.signedRequest(endpoint, "POST", body, market);
    const elapsed = Date.now() - start;

    const payload = await response.json();
    if (!response.ok) {
      console.error("Binance order error", payload);
      throw new Error(payload?.msg ?? "Failed to place order");
    }

    const fills = Array.isArray(payload.fills) ? payload.fills : [];
    const executedQty = Number(payload.executedQty ?? params.quantity);
    const cumulativeQuote = Number(payload.cummulativeQuoteQty ?? 0);

    let executedPrice = 0;
    if (fills.length > 0) {
      const totalQuote = fills.reduce((sum: number, fill: { price?: string; qty?: string }) =>
        sum + Number(fill.price ?? 0) * Number(fill.qty ?? 0), 0);
      const totalQty = fills.reduce((sum: number, fill: { qty?: string }) => sum + Number(fill.qty ?? 0), 0);
      executedPrice = totalQty > 0 ? totalQuote / totalQty : 0;
    }

    if (!executedPrice && executedQty > 0 && cumulativeQuote > 0) {
      executedPrice = cumulativeQuote / executedQty;
    }

    if (!executedPrice) {
      executedPrice = Number(payload.price ?? payload.avgPrice ?? 0);
    }

    if (!executedPrice && params.price) {
      executedPrice = params.price;
    }

    const totalFees = fills.reduce((sum: number, fill: { commission?: string }) => sum + Number(fill.commission ?? 0), 0);
    const slippage = params.price ? ((executedPrice - params.price) / params.price) * 100 : null;

    const { error } = await this.supabase.from("trades").insert({
      user_id: this.userId,
      exchange: market === "futures" ? "BINANCE_FUTURES" : "BINANCE",
      pair: params.symbol,
      side: params.side,
      price: executedPrice,
      quantity: executedQty,
      fees: totalFees,
      status: payload.status ?? "NEW",
      execution_time_ms: elapsed,
      entry_price: executedPrice,
      exit_price: null,
      slippage,
    });

    if (error) {
      console.error("Failed to persist trade", error);
    }

    return payload;
  }
}
