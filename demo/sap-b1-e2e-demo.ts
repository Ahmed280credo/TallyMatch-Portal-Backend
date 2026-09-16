// ============================================================================
// End-to-end demo: mock SAP B1 -> 3-way match -> push invoice -> poll for paid.
//
// Prereq: the mock server must already be running (npm run mock:sap-b1).
// Run:    npm run demo:sap-b1
//
// Walks through exactly the flow TallyMatch needs once real Spar FMCG
// credentials replace the mock:
//   1. PO exists in SAP B1, GRN exists (received against that PO)
//   2. We "extract" an invoice (stubbed here — in prod this is Gemini output)
//   3. Match it against the PO/GRN pulled from SAP B1 via our real 3-way
//      matching engine (src/invoices/services/three-way-matching.service.ts)
//   4. Push the matched invoice into SAP B1 as a Purchase Invoice
//   5. Simulate the client paying it from inside their own SAP B1
//   6. Poll SAP B1 and confirm our connector picks up the status change
// ============================================================================
import { SapB1SessionService } from "../src/integrations/sap-b1/sap-b1-session.service.js";
import { SapB1ClientService } from "../src/integrations/sap-b1/sap-b1-client.service.js";
import { SapB1ConnectorService } from "../src/integrations/sap-b1/sap-b1-connector.service.js";
import { mapPurchaseOrderToInternal, mapPurchaseDeliveryNoteToInternal } from "../src/integrations/sap-b1/sap-b1-mapping.js";
import { SAP_B1_OBJECT_TYPE } from "../src/integrations/sap-b1/sap-b1.types.js";
import { runThreeWayMatch } from "../src/invoices/services/three-way-matching.service.js";
import type { ExtractedInvoice } from "../src/invoices/schemas/invoice-extraction.schema.js";
import { sapB1Config } from "../src/integrations/sap-b1/sap-b1.config.js";

const config = sapB1Config();
// The connector is multi-tenant (sessions/requests keyed per org id). This
// demo has no real org, so it just uses a fixed key — a real caller passes
// the actual org id here.
const DEMO_CACHE_KEY = "demo-org";

function step(n: number, label: string) {
  console.log(`\n── ${n}. ${label} ──────────────────────────────`);
}

async function main() {
  // Standalone script — no Nest DI container here, so wire the three
  // services together by hand exactly like SapB1Module does.
  const session = new SapB1SessionService();
  const client = new SapB1ClientService(session);
  const connector = new SapB1ConnectorService(client);

  step(1, "Reset and seed the mock SAP B1 instance");
  await fetch(`${config.baseUrl}/__mock/reset`, { method: "POST" });
  const seedRes = await fetch(`${config.baseUrl}/__mock/seed`, { method: "POST" });
  if (!seedRes.ok) {
    throw new Error(
      `Could not seed mock SAP B1 (HTTP ${seedRes.status}). Is the mock server running? ` +
        `Start it first with: npm run mock:sap-b1`
    );
  }
  console.log("Mock SAP B1 seeded with demo PO/GRN data.");

  step(2, "Pull Purchase Orders and Purchase Delivery Notes (GRNs) from SAP B1");
  const [pos, grns] = await Promise.all([
    connector.fetchPurchaseOrders(config, DEMO_CACHE_KEY),
    connector.fetchPurchaseDeliveryNotes(config, DEMO_CACHE_KEY),
  ]);
  const po = pos[0];
  const grn = grns.find((g) => g.DocumentLines[0]?.BaseEntry === po.DocEntry);
  if (!po || !grn) throw new Error("Seed data missing expected PO/GRN pair");
  console.log(`PO DocNum=${po.DocNum} (${po.CardName}), GRN DocNum=${grn.DocNum} chained to it`);

  step(3, "Map SAP B1 documents onto TallyMatch's internal matching types");
  const poByDocEntry = new Map(pos.map((p) => [p.DocEntry, p]));
  const internalPo = mapPurchaseOrderToInternal(po);
  const internalGrn = mapPurchaseDeliveryNoteToInternal(grn, poByDocEntry);
  console.log(`Mapped po_number="${internalPo.po_number}" grn_number="${internalGrn.grn_number}"`);

  step(4, "Simulate an extracted invoice referencing that PO (stands in for Gemini output)");
  const extractedInvoice: ExtractedInvoice = {
    vendor_name: po.CardName,
    vendor_ntn: null,
    invoice_number: `INV-DEMO-${po.DocNum}`,
    po_number: internalPo.po_number,
    grn_number: internalGrn.grn_number,
    invoice_date: new Date().toISOString().slice(0, 10),
    due_date: null,
    // Invoice line items match the PO/GRN exactly — subtotal (pre-tax) is
    // what gets compared to the PO total; total_amount includes tax on top,
    // same as a real vendor invoice, and must NOT affect the match (see
    // three-way-matching.service.ts's pre-tax comparison fix).
    subtotal: po.DocTotal,
    tax_amount: Math.round(po.DocTotal * 0.18),
    total_amount: po.DocTotal + Math.round(po.DocTotal * 0.18),
    currency: "PKR",
    payment_terms: null,
    vendor_bank_name: null,
    vendor_account_number: null,
    vendor_iban: null,
    line_items: po.DocumentLines.map((line) => ({
      sku: line.ItemCode,
      description: line.ItemDescription,
      quantity: line.Quantity,
      unit_price: line.UnitPrice,
      amount: line.LineTotal,
    })),
  };

  step(5, "Run the real 3-way matching engine");
  const matchResult = runThreeWayMatch(extractedInvoice, [internalPo], [internalGrn]);
  console.log(`Match status: ${matchResult.status}`);
  if (matchResult.mismatch_reasons.length) console.log("Mismatches:", matchResult.mismatch_reasons);
  if (matchResult.pending_reasons.length) console.log("Pending:", matchResult.pending_reasons);

  if (matchResult.status !== "approved") {
    throw new Error(`Expected the demo invoice to auto-approve, got "${matchResult.status}" — seed data or mapping bug`);
  }

  step(6, "Push the matched invoice into SAP B1 as a Purchase Invoice");
  const pushedInvoice = await connector.pushPurchaseInvoice(config, DEMO_CACHE_KEY, {
    CardCode: po.CardCode,
    CardName: po.CardName,
    DocDate: extractedInvoice.invoice_date!,
    DocDueDate: extractedInvoice.invoice_date!,
    Comments: `Auto-pushed by TallyMatch — matched against PO ${po.DocNum} / GRN ${grn.DocNum}`,
    DocumentLines: grn.DocumentLines.map((line) => ({
      LineNum: line.LineNum,
      ItemCode: line.ItemCode,
      ItemDescription: line.ItemDescription,
      Quantity: line.Quantity,
      UnitPrice: line.UnitPrice,
      LineTotal: line.LineTotal,
      // Chains the invoice back to the GRN it was matched against —
      // SAP B1's standard PO -> GRN -> Invoice base-document linkage.
      BaseType: SAP_B1_OBJECT_TYPE.PurchaseDeliveryNote,
      BaseEntry: grn.DocEntry,
      BaseLine: line.LineNum,
    })),
  });
  console.log(`Pushed Purchase Invoice DocEntry=${pushedInvoice.DocEntry} DocNum=${pushedInvoice.DocNum}`);

  step(7, "Poll status immediately — should still be unpaid");
  const beforePay = await connector.fetchPurchaseInvoiceStatus(config, DEMO_CACHE_KEY, pushedInvoice.DocEntry);
  console.log(`DocumentStatus=${beforePay.invoice.DocumentStatus} isPaid=${beforePay.isPaid}`);
  if (beforePay.isPaid) throw new Error("Invoice shows paid before we simulated payment — bug");

  step(8, "Simulate the client paying it from inside their own SAP B1");
  // A real integration would never call this — it exists only so the mock
  // can stand in for "someone in the client's SAP B1 clicked Pay".
  const cookieHeader = await session.getCookieHeader(config, DEMO_CACHE_KEY);
  await fetch(`${config.baseUrl}/__mock/PurchaseInvoices(${pushedInvoice.DocEntry})/markPaid`, {
    method: "POST",
    headers: { Cookie: cookieHeader },
  });
  console.log("Marked paid in mock SAP B1.");

  step(9, "Poll again — our connector should now see it as paid");
  const afterPay = await connector.fetchPurchaseInvoiceStatus(config, DEMO_CACHE_KEY, pushedInvoice.DocEntry);
  console.log(`DocumentStatus=${afterPay.invoice.DocumentStatus} isPaid=${afterPay.isPaid} PaidToDate=${afterPay.invoice.PaidToDate}`);
  if (!afterPay.isPaid) throw new Error("Polling did not pick up the payment — bug");

  console.log("\nEnd-to-end demo passed: seed -> match -> push -> pay -> poll all worked. 🎉");
}

main().catch((err) => {
  console.error("\nDemo failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
