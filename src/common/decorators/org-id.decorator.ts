import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

export const OrgId = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const request = context.switchToHttp().getRequest<Request>();
  const header = request.header("x-org-id");
  return header?.trim();
});

