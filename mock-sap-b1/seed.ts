// ============================================================================
// MOCK SAP B1 — demo seed data.
//
// Populates the store with a couple of realistic PO -> GRN chains so the
// end-to-end demo (demo/sap-b1-e2e-demo.ts) has something to match against.
// Run standalone with `npx tsx mock-sap-b1/seed.ts` against a running mock
// server (POSTs directly into the shared in-memory store via import, not
// over HTTP — see runSeedScript() if you want it exercised over the wire).
// ============================================================================
import { store } from "./store.js";
import type { DocumentLine, MockPurchaseDeliveryNote, MockPurchaseOrder } from "./types.js";
import { SAP_B1_OBJECT_TYPE } from "./types.js";

interface PoGrnPair {
  cardCode: string;
  cardName: string;
  docDate: string;
  docDueDate: string;
  grnDate: string;
  lines: Array<Omit<DocumentLine, "LineNum" | "LineTotal" | "BaseType" | "BaseEntry" | "BaseLine">>;
  // GRN received in full, or only partially (tests the multi-GRN /
  // partial-delivery path our own 3-way matcher already handles)
  received: "full" | "partial";
}

const DEMO_VENDORS: PoGrnPair[] = [
  {
    cardCode: "V-10023",
    cardName: "Spar FMCG Distributors (Pvt) Ltd",
    docDate: "2026-09-01",
    docDueDate: "2026-10-01",
    grnDate: "2026-09-05",
    received: "full",
    lines: [
      { ItemCode: "FMCG-COOKOIL-5L", ItemDescription: "Cooking Oil 5L Can", Quantity: 200, UnitPrice: 2450, WarehouseCode: "WH-KHI-01" },
      { ItemCode: "FMCG-RICE-40KG", ItemDescription: "Basmati Rice 40kg Bag", Quantity: 60, UnitPrice: 12800, WarehouseCode: "WH-KHI-01" },
    ],
  },
  {
    cardCode: "V-10047",
    cardName: "Al-Noor Grocery Wholesalers",
    docDate: "2026-09-03",
    docDueDate: "2026-10-03",
    grnDate: "2026-09-08",
    received: "partial",
    lines: [
      { ItemCode: "FMCG-SUGAR-50KG", ItemDescription: "White Sugar 50kg Bag", Quantity: 100, UnitPrice: 6200, WarehouseCode: "WH-LHR-02" },
      { ItemCode: "FMCG-TEA-1KG", ItemDescription: "Black Tea 1kg Pack", Quantity: 150, UnitPrice: 980, WarehouseCode: "WH-LHR-02" },
    ],
  },
];

function withLineTotal(line: PoGrnPair["lines"][number], lineNum: number): DocumentLine {
  return { ...line, LineNum: lineNum, LineTotal: line.Quantity * line.UnitPrice };
}

export function seedDemoData(): { pos: MockPurchaseOrder[]; grns: MockPurchaseDeliveryNote[] } {
  const pos: MockPurchaseOrder[] = [];
  const grns: MockPurchaseDeliveryNote[] = [];

  for (const vendor of DEMO_VENDORS) {
    const poLines = vendor.lines.map((line, i) => withLineTotal(line, i));

    const po: MockPurchaseOrder = {
      DocEntry: store.allocateDocEntry("PO"),
      DocNum: store.allocateDocNum("PO"),
      CardCode: vendor.cardCode,
      CardName: vendor.cardName,
      DocDate: vendor.docDate,
      DocDueDate: vendor.docDueDate,
      DocTotal: poLines.reduce((sum, l) => sum + l.LineTotal, 0),
      DocumentStatus: "bost_Open",
      DocumentLines: poLines,
    };
    store.purchaseOrders.set(po.DocEntry, po);
    pos.push(po);

    // GRN (Purchase Delivery Note) chained to the PO via BaseEntry/BaseType/BaseLine.
    // A "partial" vendor only receives half the ordered quantity per line, to
    // exercise the same partial-delivery matching path as production data.
    const receivedFraction = vendor.received === "partial" ? 0.5 : 1;
    const grnLines: DocumentLine[] = poLines.map((line) => {
      const qty = vendor.received === "partial" ? Math.floor(line.Quantity * receivedFraction) : line.Quantity;
      return {
        LineNum: line.LineNum,
        ItemCode: line.ItemCode,
        ItemDescription: line.ItemDescription,
        Quantity: qty,
        UnitPrice: line.UnitPrice,
        LineTotal: qty * line.UnitPrice,
        WarehouseCode: line.WarehouseCode,
        BaseType: SAP_B1_OBJECT_TYPE.PurchaseOrder,
        BaseEntry: po.DocEntry,
        BaseLine: line.LineNum,
      };
    });

    const grn: MockPurchaseDeliveryNote = {
      DocEntry: store.allocateDocEntry("PDN"),
      DocNum: store.allocateDocNum("PDN"),
      CardCode: vendor.cardCode,
      CardName: vendor.cardName,
      DocDate: vendor.grnDate,
      DocTotal: grnLines.reduce((sum, l) => sum + l.LineTotal, 0),
      DocumentStatus: "bost_Close",
      DocumentLines: grnLines,
    };
    store.purchaseDeliveryNotes.set(grn.DocEntry, grn);
    grns.push(grn);
  }

  return { pos, grns };
}

// Allows `npx tsx mock-sap-b1/seed.ts` to run standalone for a quick sanity
// check of what gets seeded, without starting the HTTP server.
const isMain = process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js");
if (isMain) {
  const { pos, grns } = seedDemoData();
  console.log("Seeded POs:", JSON.stringify(pos, null, 2));
  console.log("Seeded GRNs:", JSON.stringify(grns, null, 2));
}
