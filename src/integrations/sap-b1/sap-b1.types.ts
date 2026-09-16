// SAP B1 Service Layer entity shapes the connector talks in. Mirrors
// mock-sap-b1/types.ts intentionally — the connector is written against this
// shape so pointing SAP_B1_BASE_URL at the real Service Layer instead of the
// mock is a config change, not a rewrite. See mock-sap-b1/types.ts for the
// ASSUMPTION notes on where we guessed at real Service Layer behavior.

export const SAP_B1_OBJECT_TYPE = {
  PurchaseOrder: "22",
  PurchaseDeliveryNote: "20",
  PurchaseInvoice: "18",
} as const;

export type DocumentStatus = "bost_Open" | "bost_Close";

export interface DocumentLine {
  LineNum: number;
  ItemCode: string;
  ItemDescription: string;
  Quantity: number;
  UnitPrice: number;
  LineTotal: number;
  WarehouseCode?: string;
  BaseType?: string;
  BaseEntry?: number;
  BaseLine?: number;
}

export interface PurchaseOrder {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: string;
  DocDueDate: string;
  DocTotal: number;
  DocumentStatus: DocumentStatus;
  DocumentLines: DocumentLine[];
}

export interface PurchaseDeliveryNote {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: string;
  DocTotal: number;
  DocumentStatus: DocumentStatus;
  DocumentLines: DocumentLine[];
}

export interface PurchaseInvoice {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: string;
  DocDueDate: string;
  DocTotal: number;
  DocumentStatus: DocumentStatus;
  PaidToDate: number;
  DocumentLines: DocumentLine[];
  Comments?: string;
}

// What we send when creating a Purchase Invoice — DocEntry/DocNum/PaidToDate
// are server-assigned and never part of the request body.
export interface CreatePurchaseInvoiceInput {
  CardCode: string;
  CardName?: string;
  DocDate: string;
  DocDueDate: string;
  Comments?: string;
  DocumentLines: Array<{
    LineNum: number;
    ItemCode: string;
    ItemDescription: string;
    Quantity: number;
    UnitPrice: number;
    LineTotal: number;
    WarehouseCode?: string;
    // Chains the invoice line back to the GRN it was matched against —
    // SAP B1's standard base-document linkage.
    BaseType: string;
    BaseEntry: number;
    BaseLine: number;
  }>;
}

export interface SapB1ErrorResponse {
  error: {
    code: number;
    message: string;
  };
}

export class SapB1Error extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly httpStatus: number
  ) {
    super(message);
    this.name = "SapB1Error";
  }
}

// Derived, not a raw Service Layer field — see ASSUMPTION note in
// mock-sap-b1/types.ts on how "paid" is inferred from DocumentStatus +
// PaidToDate.
export function isPurchaseInvoicePaid(invoice: PurchaseInvoice): boolean {
  return invoice.DocumentStatus === "bost_Close" && invoice.PaidToDate >= invoice.DocTotal;
}
