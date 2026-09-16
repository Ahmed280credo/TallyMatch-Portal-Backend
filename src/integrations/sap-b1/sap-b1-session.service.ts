import { Injectable, Logger } from "@nestjs/common";
import { sapB1Config } from "./sap-b1.config.js";
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
@Injectable()
export class SapB1SessionService {
  private readonly logger = new Logger(SapB1SessionService.name);
  private session: SessionState | null = null;
  private loginPromise: Promise<string> | null = null;

  async getCookieHeader(): Promise<string> {
    if (this.session && Date.now() < this.session.expiresAt - REAUTH_SAFETY_MARGIN_MS) {
      return this.session.cookieHeader;
    }
    return this.login();
  }

  // Called by the client on a 401 mid-request, in case the session died
  // early (server restart, admin killed it, etc.) — forces a fresh login
  // regardless of what we think the expiry is.
  invalidate(): void {
    this.session = null;
  }

  private async login(): Promise<string> {
    // Coalesce concurrent callers into a single login request instead of
    // each firing its own — avoids hammering Service Layer with parallel
    // /Login calls when several connector calls race on a cold/expired session.
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = this.doLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async doLogin(): Promise<string> {
    const config = sapB1Config();
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

    this.session = {
      cookieHeader,
      expiresAt: Date.now() + body.SessionTimeout * 60_000,
    };

    this.logger.log(`SAP B1 session established (timeout ${body.SessionTimeout}m)`);
    return cookieHeader;
  }
}
