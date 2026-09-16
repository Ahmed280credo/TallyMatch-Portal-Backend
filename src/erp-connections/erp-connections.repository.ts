import { Inject, Injectable } from "@nestjs/common";
import { SUPABASE_CLIENT } from "../database/supabase.client.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ErpConnection } from "../invoices/types/database.js";

type ErpConnectionInsert = Database["public"]["Tables"]["erp_connections"]["Insert"];
type ErpConnectionUpdate = Database["public"]["Tables"]["erp_connections"]["Update"];

function requireOrgId(orgId: string) {
  if (!orgId || orgId.trim().length < 8) {
    throw new Error("Refusing unscoped database query: org_id is required");
  }
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  return data as T;
}

@Injectable()
export class ErpConnectionsRepository {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async getByOrgId(orgId: string): Promise<ErpConnection | null> {
    requireOrgId(orgId);
    const { data, error } = await this.supabase
      .from("erp_connections")
      .select("*")
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data as ErpConnection | null;
  }

  async upsert(orgId: string, patch: Omit<ErpConnectionInsert, "org_id">): Promise<ErpConnection> {
    requireOrgId(orgId);
    const { data, error } = await this.supabase
      .from("erp_connections")
      .upsert({ ...patch, org_id: orgId }, { onConflict: "org_id" })
      .select("*")
      .single();

    return unwrap(data as ErpConnection, error);
  }

  async update(orgId: string, patch: ErpConnectionUpdate): Promise<ErpConnection> {
    requireOrgId(orgId);
    const { data, error } = await this.supabase
      .from("erp_connections")
      .update(patch)
      .eq("org_id", orgId)
      .select("*")
      .single();

    return unwrap(data as ErpConnection, error);
  }
}
