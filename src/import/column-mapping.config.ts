export interface FieldSpec {
  /** internal field name written into the mapped row */
  field: string;
  /** accepted header spellings (matched case/whitespace/punctuation-insensitively) */
  aliases: string[];
  required: boolean;
}

export const PO_FIELDS: FieldSpec[] = [
  {
    field: "po_number",
    aliases: ["Purchase Order No", "Purchase Order Number", "PO Number", "PO No", "PO#", "PO Ref", "PO Reference"],
    required: true,
  },
  {
    field: "vendor_name",
    aliases: ["Supplier Name", "Vendor Name", "Vendor", "Supplier"],
    required: true,
  },
  {
    field: "total_amount",
    aliases: ["Net Amount", "Total Amount", "Amount", "Total", "Grand Total", "PO Amount"],
    required: true,
  },
  {
    field: "date",
    aliases: ["Order Date", "PO Date", "Date"],
    required: false,
  },
  {
    field: "item_description",
    aliases: ["Item Description", "Description", "Item", "Item Name"],
    required: false,
  },
  {
    field: "quantity",
    aliases: ["Quantity", "Qty"],
    required: false,
  },
  {
    field: "unit_price",
    aliases: ["Unit Price", "Price", "Rate"],
    required: false,
  },
];

export const GRN_FIELDS: FieldSpec[] = [
  {
    field: "grn_number",
    aliases: ["GRN No", "GRN Number", "GRN#", "GRN Ref", "GRN Reference"],
    required: true,
  },
  {
    field: "vendor_name",
    aliases: ["Supplier Name", "Vendor Name", "Vendor", "Supplier"],
    required: true,
  },
  {
    field: "po_number",
    aliases: ["PO Reference", "PO Number", "Purchase Order No", "PO No", "PO#"],
    required: false,
  },
  {
    field: "total_received_amount",
    aliases: ["Total Received Amount", "Total Amount", "Net Amount", "Amount", "GRN Amount", "Total"],
    required: false,
  },
  {
    field: "date",
    aliases: ["Received Date", "GRN Date", "Date"],
    required: false,
  },
  {
    field: "item_description",
    aliases: ["Item Description", "Description", "Item", "Item Name"],
    required: false,
  },
  {
    field: "quantity_received",
    aliases: ["Quantity Received", "Qty Received", "Quantity", "Qty"],
    required: false,
  },
];
