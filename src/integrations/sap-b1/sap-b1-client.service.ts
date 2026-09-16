import { Injectable } from "@nestjs/common";
import { sapB1Config } from "./sap-b1.config.js";
import { SapB1SessionService } from "./sap-b1-session.service.js";
import { SapB1Error, type SapB1ErrorResponse } from "./sap-b1.types.js";

// Low-level Service Layer HTTP client: attaches the session cookie, retries
// exactly once on a 401 (session died mid-flight), and normalizes error
// responses into SapB1Error. Nothing here knows about invoices/POs/GRNs
// specifically — that's sap-b1-connector.service.ts.
@Injectable()
export class SapB1ClientService {
  constructor(private readonly session: SapB1SessionService) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, isRetry = false): Promise<T> {
    const config = sapB1Config();
    const cookieHeader = await this.session.getCookieHeader();

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
      this.session.invalidate();
      return this.request<T>(method, path, body, true);
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
