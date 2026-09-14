import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { User } from "@supabase/supabase-js";

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): User | undefined => {
  const request = context.switchToHttp().getRequest<Request>();
  return (request as Request & { user?: User }).user;
});
