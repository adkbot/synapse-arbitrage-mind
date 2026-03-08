import { supabase } from '@/integrations/supabase/client';
import type { ApiBotSnapshot, ApiSettingsState, ApiSettingsUpdate } from '@/types/api';

async function invoke<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  if (!token) {
    throw new Error('Você precisa estar autenticado para usar esta funcionalidade.');
  }

  const { data, error } = await supabase.functions.invoke('bot-engine', {
    body: { action, ...body },
  });

  if (error) {
    throw new Error(error.message ?? 'Erro ao chamar o backend.');
  }

  return data as T;
}

export const backendClient = {
  async getState(): Promise<ApiBotSnapshot> {
    const data = await invoke<{ snapshot: ApiBotSnapshot }>('get_state');
    return data.snapshot;
  },

  async startBot(options: Record<string, unknown> = {}): Promise<ApiBotSnapshot> {
    const data = await invoke<{ snapshot: ApiBotSnapshot }>('start_bot', options);
    return data.snapshot;
  },

  async stopBot(): Promise<ApiBotSnapshot> {
    const data = await invoke<{ snapshot: ApiBotSnapshot }>('stop_bot');
    return data.snapshot;
  },

  async sync(): Promise<ApiBotSnapshot> {
    const data = await invoke<{ snapshot: ApiBotSnapshot }>('sync');
    return data.snapshot;
  },

  async getSettings(): Promise<ApiSettingsState> {
    const data = await invoke<{ settings: ApiSettingsState }>('get_settings');
    return data.settings;
  },

  async updateSettings(payload: ApiSettingsUpdate): Promise<ApiSettingsState> {
    const data = await invoke<{ settings: ApiSettingsState }>('update_settings', payload as Record<string, unknown>);
    return data.settings;
  },

  async getSystemStatus() {
    return invoke<{
      status: {
        binanceConnection: 'connected' | 'disconnected' | 'error';
        regionalStatus: 'full' | 'partial' | 'restricted';
        websocketStatus: 'connected' | 'disconnected';
        apiKeys: 'configured' | 'missing' | 'invalid';
        region: string;
        restrictions: string[];
        connectivity: boolean;
      };
    }>('system_status');
  },

  async getKeysState() {
    return invoke<{
      configured: boolean;
      testnet: boolean;
      updatedAt: string | null;
      mode: string;
      apiKeyMask: string;
    }>('get_keys');
  },

  async saveKeys(payload: { apiKey: string; apiSecret: string; testnet: boolean; mode: string }) {
    return invoke<{ success: boolean; state: Record<string, unknown> }>('save_keys', payload);
  },
};
