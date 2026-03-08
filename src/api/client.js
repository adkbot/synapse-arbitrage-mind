import { backendClient } from '@/lib/backendClient';

export async function getKeysState() {
  return backendClient.getKeysState();
}

export async function saveKeys(body) {
  return backendClient.saveKeys(body);
}
