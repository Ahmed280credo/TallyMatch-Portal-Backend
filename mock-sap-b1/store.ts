// ============================================================================
// MOCK SAP B1 — in-memory data store.
//
// Everything here resets when the mock server process restarts. That's
// intentional: this is a throwaway stand-in for the real Service Layer, not
// a persistence layer we need to keep.
// ============================================================================
import type { MockPurchaseOrder, MockPurchaseDeliveryNote, MockPurchaseInvoice } from "./types.js";

interface Session {
  companyDB: string;
  userName: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TIMEOUT_MINUTES = Number(process.env.MOCK_SAP_B1_SESSION_TIMEOUT_MINUTES ?? 30);

// Credentials the mock accepts — override via env if you want to simulate a
// specific CompanyDB/user without touching code.
export const MOCK_CREDENTIALS = {
  companyDB: process.env.MOCK_SAP_B1_COMPANY_DB ?? "SPAR_FMCG_TEST",
  userName: process.env.MOCK_SAP_B1_USERNAME ?? "manager",
  password: process.env.MOCK_SAP_B1_PASSWORD ?? "mock-password",
};

class MockSapB1Store {
  sessions = new Map<string, Session>();
  purchaseOrders = new Map<number, MockPurchaseOrder>();
  purchaseDeliveryNotes = new Map<number, MockPurchaseDeliveryNote>();
  purchaseInvoices = new Map<number, MockPurchaseInvoice>();

  private nextDocEntry = { PO: 1000, PDN: 2000, INV: 3000 };
  private nextDocNum = { PO: 90001, PDN: 91001, INV: 92001 };

  createSession(): { sessionId: string; timeoutMinutes: number } {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    this.sessions.set(sessionId, {
      companyDB: MOCK_CREDENTIALS.companyDB,
      userName: MOCK_CREDENTIALS.userName,
      createdAt: now,
      expiresAt: now + SESSION_TIMEOUT_MINUTES * 60_000,
    });
    return { sessionId, timeoutMinutes: SESSION_TIMEOUT_MINUTES };
  }

  isSessionValid(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  logout(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  allocateDocEntry(kind: "PO" | "PDN" | "INV"): number {
    return this.nextDocEntry[kind]++;
  }

  allocateDocNum(kind: "PO" | "PDN" | "INV"): number {
    return this.nextDocNum[kind]++;
  }

  reset(): void {
    this.sessions.clear();
    this.purchaseOrders.clear();
    this.purchaseDeliveryNotes.clear();
    this.purchaseInvoices.clear();
    this.nextDocEntry = { PO: 1000, PDN: 2000, INV: 3000 };
    this.nextDocNum = { PO: 90001, PDN: 91001, INV: 92001 };
  }
}

export const store = new MockSapB1Store();
