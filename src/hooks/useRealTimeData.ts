import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '@/lib/backendClient';
import type { ApiBotSnapshot } from '@/types/api';

type RealTimeBalance = ApiBotSnapshot['balances'][number];
type RealTimeTrade = ApiBotSnapshot['trades'][number];

const emptySnapshot: ApiBotSnapshot = {
  balances: [],
  trades: [],
  metrics: {
    total_pnl: 0,
    daily_pnl: 0,
    total_trades: 0,
    success_rate: 0,
    avg_latency: 0,
    active_pairs: 0,
    ai_confidence: 0,
  },
  status: {
    running: false,
    tradingPair: 'BTCUSDT',
    pollIntervalMs: 5000,
    lastCycleAt: null,
    lastTradeAt: null,
  },
};

export const useRealTimeData = () => {
  const [snapshot, setSnapshot] = useState<ApiBotSnapshot>(emptySnapshot);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const loadInitial = async () => {
      setIsLoading(true);
      try {
        const initial = await backendClient.getState();
        if (!closed) {
          setSnapshot(initial);
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError((err as Error).message ?? 'Erro ao carregar dados em tempo real.');
        }
      } finally {
        if (!closed) {
          setIsLoading(false);
        }
      }

      // Poll every 10 seconds instead of SSE (edge functions don't support SSE)
      if (!closed) {
        pollTimer = setInterval(async () => {
          try {
            const data = await backendClient.getState();
            if (!closed) {
              setSnapshot(data);
              setError(null);
            }
          } catch {
            // silent - will retry next interval
          }
        }, 10000);
      }
    };

    loadInitial();

    return () => {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  const startBot = useCallback(async () => {
    try {
      const updated = await backendClient.startBot();
      setSnapshot(updated);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Erro ao iniciar o bot.');
      throw err;
    }
  }, []);

  const stopBot = useCallback(async () => {
    try {
      const updated = await backendClient.stopBot();
      setSnapshot(updated);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Erro ao parar o bot.');
      throw err;
    }
  }, []);

  const syncWithBackend = useCallback(async () => {
    try {
      const updated = await backendClient.sync();
      setSnapshot(updated);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Erro ao sincronizar com a corretora.');
      throw err;
    }
  }, []);

  const refreshData = useCallback(async () => {
    try {
      const updated = await backendClient.getState();
      setSnapshot(updated);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Erro ao atualizar dados.');
      throw err;
    }
  }, []);

  return {
    balances: snapshot.balances as RealTimeBalance[],
    trades: snapshot.trades as RealTimeTrade[],
    metrics: snapshot.metrics,
    status: snapshot.status,
    isLoading,
    error,
    syncWithBinance: syncWithBackend,
    refreshData,
    startBot,
    stopBot,
  };
};
