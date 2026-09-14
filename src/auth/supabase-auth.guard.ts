import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { SUPABASE_CLIENT } from "../database/supabase.client.js";

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("Missing Bearer token");

    const token = auth.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) throw new UnauthorizedException("Invalid or expired token");

    (req as any).user = data.user;

    const rawOrgId = (req.headers["x-org-id"] as string | undefined)?.trim();
    if (rawOrgId && rawOrgId.length >= 8) {
      const { data: member, error: memberErr } = await this.supabase
        .from("organization_members")
        .select("id, role")
        .eq("org_id", rawOrgId)
        .eq("user_id", data.user.id)
        .maybeSingle();

      if (memberErr || !member) {
        throw new ForbiddenException(`Forbidden: Authenticated user does not belong to organization '${rawOrgId}'`);
      }
      (req as any).orgMember = member;
    }

    return true;
  }
}
