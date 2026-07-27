export interface ColumnMapping {
  [externalColumn: string]: string;
}

export const PO_COLUMN_MAPPING: ColumnMapping = {
  "Purchase Order No": "po_number",
  "Supplier Name": "vendor_name",
  "Net Amount": "total_amount",
  "Order Date": "date",
  "Item Description": "item_description",
  "Quantity": "quantity",
  "Unit Price": "unit_price",
};

export const GRN_COLUMN_MAPPING: ColumnMapping = {
  "GRN No": "grn_number",
  "PO Reference": "po_number",
  "Supplier Name": "vendor_name",
  "Received Date": "date",
  "Item Description": "item_description",
  "Quantity Received": "quantity_received",
};

export const PO_REQUIRED_FIELDS = ["po_number", "vendor_name", "total_amount"] as const;
export const GRN_REQUIRED_FIELDS = ["grn_number", "vendor_name"] as const;
