import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment configuration.");
}

type UserContext = {
  admin: SupabaseClient;
  userClient: SupabaseClient;
  user: {
    id: string;
    email?: string;
  };
  token: string;
};

export function createAdminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

export async function requireUserContext(req: Request): Promise<UserContext> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Error("Unauthorized");
  }

  const token = authHeader.replace("Bearer", "").trim();
  if (!token) {
    throw new Error("Unauthorized");
  }

  const admin = createAdminClient();
  const {
    data: { user },
    error,
  } = await admin.auth.getUser(token);

  if (error || !user) {
    throw new Error("Unauthorized");
  }

  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SERVICE_ROLE_KEY,
      },
    },
    auth: { persistSession: false },
  });

  return {
    admin,
    userClient,
    user: { id: user.id, email: user.email ?? undefined },
    token,
  };
}
