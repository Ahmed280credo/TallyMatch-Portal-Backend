// ============================================================================
// MOCK SAP Business One Service Layer — entity shapes.
//
// These mirror the real Service Layer's OData-style JSON as closely as we
// could determine WITHOUT live access to the client's (Spar FMCG) cloud-hosted
// SAP B1 instance. Anywhere we guessed, it's flagged with an ASSUMPTION
// comment — verify against the real sandbox before relying on it in prod.
// ============================================================================

// SAP B1 BoObjectTypes — standard, widely-documented values used for the
// BaseType field when chaining documents (PO -> GRN -> Invoice).
// ASSUMPTION: these are the standard values across SAP B1 versions, but
// worth a sanity check against the client's actual instance.
export const SAP_B1_OBJECT_TYPE = {
  PurchaseOrder: "22",
  PurchaseDeliveryNote: "20",
  PurchaseInvoice: "18",
} as const;

// ASSUMPTION: Service Layer's DocumentStatus enum values. Real SAP B1 exposes
// these as "bost_Open" / "bost_Close" strings in Service Layer JSON.
export type DocumentStatus = "bost_Open" | "bost_Close";

export interface DocumentLine {
  LineNum: number;
  ItemCode: string;
  ItemDescription: string;
  Quantity: number;
  UnitPrice: number;
  LineTotal: number;
  WarehouseCode?: string;
  // Present on GRN/Invoice lines that were copied-forward from a base
  // document — this is SAP B1's standard PO -> GRN -> Invoice chaining
  // mechanism, NOT something specific to our mock.
  BaseType?: string;
  BaseEntry?: number;
  BaseLine?: number;
}

export interface MockPurchaseOrder {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: string; // YYYY-MM-DD
  DocDueDate: string;
  DocTotal: number;
  DocumentStatus: DocumentStatus;
  DocumentLines: DocumentLine[];
}

export interface MockPurchaseDeliveryNote {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: string;
  DocTotal: number;
  DocumentStatus: DocumentStatus;
  DocumentLines: DocumentLine[];
}

export interface MockPurchaseInvoice {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: string;
  DocDueDate: string;
  DocTotal: number;
  DocumentStatus: DocumentStatus;
  // ASSUMPTION: real SAP B1 tracks payment via PaidToDate vs DocTotal plus
  // DocumentStatus, not a single "Paid" flag. We derive "paid" as
  // DocumentStatus === "bost_Close" && PaidToDate >= DocTotal, matching how
  // a real Service Layer consumer would have to interpret it too.
  PaidToDate: number;
  DocumentLines: DocumentLine[];
  Comments?: string;
}

// Standard Service Layer error envelope. ASSUMPTION: some real deployments
// nest `message` as { lang, value } instead of a plain string — this mock
// uses a plain string per the simpler shape most integrations code against;
// double-check against the live client sandbox before hard-coding a parser.
export interface SapB1ErrorResponse {
  error: {
    code: number;
    message: string;
  };
}

export interface LoginRequestBody {
  CompanyDB: string;
  UserName: string;
  Password: string;
}

// "odata.metadata" is a real field on the wire but not a valid TS identifier,
// so this is built as a plain object literal in server.ts rather than typed
// here — see the /Login handler.
