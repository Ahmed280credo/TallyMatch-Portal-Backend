// ============================================================================
// MOCK SAP Business One Service Layer.
//
// Stands in for the real Service Layer at Spar FMCG (cloud-hosted SAP B1)
// until we get live credentials. This is NOT production code — it exists so
// src/integrations/sap-b1/ (the real connector) can be built and tested
// against something that behaves like Service Layer before we have the real
// thing. Swapping to the real Service Layer later is a config change
// (SAP_B1_BASE_URL etc.) in the connector, not a rewrite of this file.
//
// Run: npx tsx mock-sap-b1/server.ts  (or `npm run mock:sap-b1`)
// ============================================================================
import express, { type NextFunction, type Request, type Response } from "express";
import { store, MOCK_CREDENTIALS } from "./store.js";
import { seedDemoData } from "./seed.js";
import type { LoginRequestBody, MockPurchaseInvoice, SapB1ErrorResponse, DocumentLine } from "./types.js";

const PORT = Number(process.env.MOCK_SAP_B1_PORT ?? 4010);
const SESSION_COOKIE = "B1SESSION";

// Auto-flip a pushed invoice to "paid" after this many ms, simulating the
// client reconciling it from inside their own SAP B1 — unless disabled
// (0 or unset means "manual trigger only", via the __mock endpoint below).
const AUTO_PAY_DELAY_MS = Number(process.env.MOCK_SAP_B1_AUTO_PAY_DELAY_MS ?? 0);

const app = express();
app.use(express.json());

function sapError(res: Response, status: number, code: number, message: string) {
  const body: SapB1ErrorResponse = { error: { code, message } };
  res.status(status).json(body);
}

function parseSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  return match?.slice(SESSION_COOKIE.length + 1);
}

// Every endpoint below /b1s/v1 except /Login requires a valid session —
// matching real Service Layer's cookie-based auth (no bearer tokens).
function requireSession(req: Request, res: Response, next: NextFunction) {
  const sessionId = parseSessionCookie(req);
  if (!store.isSessionValid(sessionId)) {
    sapError(res, 401, 301, "Invalid session (expired or never logged in) — call /Login again");
    return;
  }
  next();
}

// ── Auth ─────────────────────────────────────────────────────────────────
app.post("/b1s/v1/Login", (req: Request<unknown, unknown, LoginRequestBody>, res: Response) => {
  const { CompanyDB, UserName, Password } = req.body ?? {};

  if (
    CompanyDB !== MOCK_CREDENTIALS.companyDB ||
    UserName !== MOCK_CREDENTIALS.userName ||
    Password !== MOCK_CREDENTIALS.password
  ) {
    sapError(res, 401, 103, "Invalid CompanyDB, UserName, or Password");
    return;
  }

  const { sessionId, timeoutMinutes } = store.createSession();

  // Real Service Layer sets both B1SESSION and ROUTEID cookies (ROUTEID is
  // for load-balancer stickiness across the app server farm) — ROUTEID is
  // meaningless for a single mock process but included so connector code
  // that stores/replays both cookies verbatim doesn't need special-casing
  // for the mock vs. the real thing.
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly`,
    `ROUTEID=.node1; Path=/`,
  ]);

  res.json({
    "odata.metadata": `http://mock-sap-b1:${PORT}/b1s/v1/$metadata#Login`,
    SessionId: sessionId,
    Version: "1000122-mock",
    SessionTimeout: timeoutMinutes,
  });
});

app.post("/b1s/v1/Logout", requireSession, (req: Request, res: Response) => {
  const sessionId = parseSessionCookie(req)!;
  store.logout(sessionId);
  res.status(204).send();
});

// ── Purchase Orders (read) ───────────────────────────────────────────────
app.get("/b1s/v1/PurchaseOrders", requireSession, (_req: Request, res: Response) => {
  res.json({
    "odata.metadata": `http://mock-sap-b1:${PORT}/b1s/v1/$metadata#PurchaseOrders`,
    value: Array.from(store.purchaseOrders.values()),
  });
});

app.get(/^\/b1s\/v1\/PurchaseOrders\((\d+)\)$/, requireSession, (req: Request, res: Response) => {
  const docEntry = Number(req.params[0]);
  const po = store.purchaseOrders.get(docEntry);
  if (!po) {
    sapError(res, 404, 2028, `PurchaseOrders(${docEntry}) not found`);
    return;
  }
  res.json(po);
});

// ── Purchase Delivery Notes / GRN (read) ─────────────────────────────────
app.get("/b1s/v1/PurchaseDeliveryNotes", requireSession, (_req: Request, res: Response) => {
  res.json({
    "odata.metadata": `http://mock-sap-b1:${PORT}/b1s/v1/$metadata#PurchaseDeliveryNotes`,
    value: Array.from(store.purchaseDeliveryNotes.values()),
  });
});

app.get(/^\/b1s\/v1\/PurchaseDeliveryNotes\((\d+)\)$/, requireSession, (req: Request, res: Response) => {
  const docEntry = Number(req.params[0]);
  const grn = store.purchaseDeliveryNotes.get(docEntry);
  if (!grn) {
    sapError(res, 404, 2028, `PurchaseDeliveryNotes(${docEntry}) not found`);
    return;
  }
  res.json(grn);
});

// ── Purchase Invoices (write + read) ─────────────────────────────────────
app.post("/b1s/v1/PurchaseInvoices", requireSession, (req: Request, res: Response) => {
  const body = req.body as Partial<MockPurchaseInvoice> | undefined;

  if (!body?.CardCode || !Array.isArray(body.DocumentLines) || body.DocumentLines.length === 0) {
    sapError(res, 400, 3072, "CardCode and at least one DocumentLine are required");
    return;
  }

  const lines: DocumentLine[] = body.DocumentLines.map((line, i) => ({
    LineNum: line.LineNum ?? i,
    ItemCode: line.ItemCode ?? "",
    ItemDescription: line.ItemDescription ?? "",
    Quantity: line.Quantity ?? 0,
    UnitPrice: line.UnitPrice ?? 0,
    LineTotal: line.LineTotal ?? (line.Quantity ?? 0) * (line.UnitPrice ?? 0),
    WarehouseCode: line.WarehouseCode,
    BaseType: line.BaseType,
    BaseEntry: line.BaseEntry,
    BaseLine: line.BaseLine,
  }));

  const docEntry = store.allocateDocEntry("INV");
  const invoice: MockPurchaseInvoice = {
    DocEntry: docEntry,
    DocNum: store.allocateDocNum("INV"),
    CardCode: body.CardCode,
    CardName: body.CardName ?? body.CardCode,
    DocDate: body.DocDate ?? new Date().toISOString().slice(0, 10),
    DocDueDate: body.DocDueDate ?? new Date().toISOString().slice(0, 10),
    DocTotal: body.DocTotal ?? lines.reduce((sum, l) => sum + l.LineTotal, 0),
    DocumentStatus: "bost_Open",
    PaidToDate: 0,
    DocumentLines: lines,
    Comments: body.Comments,
  };
  store.purchaseInvoices.set(docEntry, invoice);

  if (AUTO_PAY_DELAY_MS > 0) {
    setTimeout(() => markInvoicePaid(docEntry), AUTO_PAY_DELAY_MS);
  }

  res.status(201).json(invoice);
});

app.get(/^\/b1s\/v1\/PurchaseInvoices\((\d+)\)$/, requireSession, (req: Request, res: Response) => {
  const docEntry = Number(req.params[0]);
  const invoice = store.purchaseInvoices.get(docEntry);
  if (!invoice) {
    sapError(res, 404, 2028, `PurchaseInvoices(${docEntry}) not found`);
    return;
  }
  res.json(invoice);
});

// ── Mock-only admin endpoints (NOT part of real Service Layer) ──────────
// Namespaced under __mock so connector code can never accidentally call
// these against the real thing — they exist purely to drive the demo/tests.
function markInvoicePaid(docEntry: number): MockPurchaseInvoice | undefined {
  const invoice = store.purchaseInvoices.get(docEntry);
  if (!invoice) return undefined;
  invoice.DocumentStatus = "bost_Close";
  invoice.PaidToDate = invoice.DocTotal;
  return invoice;
}

app.post(/^\/b1s\/v1\/__mock\/PurchaseInvoices\((\d+)\)\/markPaid$/, requireSession, (req: Request, res: Response) => {
  const docEntry = Number(req.params[0]);
  const invoice = markInvoicePaid(docEntry);
  if (!invoice) {
    sapError(res, 404, 2028, `PurchaseInvoices(${docEntry}) not found`);
    return;
  }
  res.json(invoice);
});

app.post("/b1s/v1/__mock/reset", (_req: Request, res: Response) => {
  store.reset();
  res.status(204).send();
});

app.post("/b1s/v1/__mock/seed", (_req: Request, res: Response) => {
  const { pos, grns } = seedDemoData();
  res.json({ pos, grns });
});

// ── Fallback: match real Service Layer's error shape for unknown routes ──
app.use((_req: Request, res: Response) => {
  sapError(res, 404, 404, "Resource not found");
});

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  app.listen(PORT, () => {
    console.log(`[mock-sap-b1] listening on http://localhost:${PORT}`);
    console.log(`[mock-sap-b1] CompanyDB=${MOCK_CREDENTIALS.companyDB} UserName=${MOCK_CREDENTIALS.userName}`);
    console.log(`[mock-sap-b1] POST /b1s/v1/__mock/seed to load demo PO/GRN data`);
  });
}

export { app };
