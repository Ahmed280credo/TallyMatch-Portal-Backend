import { Injectable } from "@nestjs/common";
import type { SapB1Config } from "./sap-b1.config.js";
import { SapB1SessionService } from "./sap-b1-session.service.js";
import { SapB1Error, type SapB1ErrorResponse } from "./sap-b1.types.js";

// Low-level Service Layer HTTP client: attaches the session cookie, retries
// exactly once on a 401 (session died mid-flight), and normalizes error
// responses into SapB1Error. Nothing here knows about invoices/POs/GRNs
// specifically — that's sap-b1-connector.service.ts.
//
// Every call takes an explicit SapB1Config + cacheKey (the org id) rather
// than reading a single global config, since each org can point at a
// different SAP B1 instance with different credentials.
@Injectable()
export class SapB1ClientService {
  constructor(private readonly session: SapB1SessionService) {}

  async get<T>(config: SapB1Config, cacheKey: string, path: string): Promise<T> {
    return this.request<T>(config, cacheKey, "GET", path);
  }

  async post<T>(config: SapB1Config, cacheKey: string, path: string, body: unknown): Promise<T> {
    return this.request<T>(config, cacheKey, "POST", path, body);
  }

  private async request<T>(
    config: SapB1Config,
    cacheKey: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    isRetry = false
  ): Promise<T> {
    const cookieHeader = await this.session.getCookieHeader(config, cacheKey);

    const res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Cookie: cookieHeader,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !isRetry) {
      // Session expired earlier than expected (server restarted, admin
      // killed it, etc.) — force one re-login and retry, matching how a
      // real Service Layer integration has to handle this since sessions
      // can die for reasons the client can't predict from SessionTimeout alone.
      this.session.invalidate(cacheKey);
      return this.request<T>(config, cacheKey, method, path, body, true);
    }

    if (!res.ok) {
      const errorBody = (await res.json().catch(() => null)) as SapB1ErrorResponse | null;
      throw new SapB1Error(
        errorBody?.error?.message ?? `SAP B1 request failed with HTTP ${res.status}`,
        errorBody?.error?.code ?? res.status,
        res.status
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
