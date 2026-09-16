import { Injectable, Logger } from "@nestjs/common";
import type { SapB1Config } from "./sap-b1.config.js";
import { SapB1Error, type SapB1ErrorResponse } from "./sap-b1.types.js";

interface SessionState {
  cookieHeader: string;
  // Real Service Layer sessions default to a 30-minute idle timeout;
  // ASSUMPTION: we re-login proactively a little early rather than reacting
  // to a 401, to avoid failing an in-flight request the instant it expires.
  expiresAt: number;
}

const REAUTH_SAFETY_MARGIN_MS = 60_000;

// Service Layer uses cookie-based sessions (B1SESSION + ROUTEID), not bearer
// tokens — this service owns login + cookie storage + expiry so the rest of
// the connector never has to think about auth.
//
// Multi-tenant: TallyMatch talks to a different SAP B1 (base URL + company +
// credentials) per organization, so a single cached session isn't enough —
// sessions are keyed by cacheKey (callers pass the org id) and held in a Map.
@Injectable()
export class SapB1SessionService {
  private readonly logger = new Logger(SapB1SessionService.name);
  private sessions = new Map<string, SessionState>();
  private loginPromises = new Map<string, Promise<string>>();

  async getCookieHeader(config: SapB1Config, cacheKey: string): Promise<string> {
    const session = this.sessions.get(cacheKey);
    if (session && Date.now() < session.expiresAt - REAUTH_SAFETY_MARGIN_MS) {
      return session.cookieHeader;
    }
    return this.login(config, cacheKey);
  }

  // Called by the client on a 401 mid-request, in case the session died
  // early (server restart, admin killed it, etc.) — forces a fresh login
  // regardless of what we think the expiry is.
  invalidate(cacheKey: string): void {
    this.sessions.delete(cacheKey);
  }

  private async login(config: SapB1Config, cacheKey: string): Promise<string> {
    // Coalesce concurrent callers into a single login request instead of
    // each firing its own — avoids hammering Service Layer with parallel
    // /Login calls when several connector calls race on a cold/expired session.
    const existing = this.loginPromises.get(cacheKey);
    if (existing) return existing;

    const promise = this.doLogin(config, cacheKey).finally(() => {
      this.loginPromises.delete(cacheKey);
    });
    this.loginPromises.set(cacheKey, promise);
    return promise;
  }

  private async doLogin(config: SapB1Config, cacheKey: string): Promise<string> {
    const res = await fetch(`${config.baseUrl}/Login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        CompanyDB: config.companyDB,
        UserName: config.userName,
        Password: config.password,
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as SapB1ErrorResponse | null;
      throw new SapB1Error(
        body?.error?.message ?? `SAP B1 login failed with HTTP ${res.status}`,
        body?.error?.code ?? res.status,
        res.status
      );
    }

    const body = (await res.json()) as { SessionId: string; SessionTimeout: number };

    // Real Service Layer sets both B1SESSION and ROUTEID cookies; ROUTEID
    // matters for load-balancer stickiness in a multi-node deployment.
    // Forward whatever Set-Cookie headers came back verbatim rather than
    // reconstructing just B1SESSION from the response body, so this works
    // unchanged against a real load-balanced Service Layer later.
    const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
    const cookieHeader =
      setCookieHeaders.length > 0
        ? setCookieHeaders.map((c) => c.split(";")[0]).join("; ")
        : `B1SESSION=${body.SessionId}`;

    this.sessions.set(cacheKey, {
      cookieHeader,
      expiresAt: Date.now() + body.SessionTimeout * 60_000,
    });

    this.logger.log(`SAP B1 session established for ${cacheKey} (timeout ${body.SessionTimeout}m)`);
    return cookieHeader;
  }
}
