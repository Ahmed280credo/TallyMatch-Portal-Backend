export interface ExtractAndMatchJobData {
  orgId: string;
  uploadedByUserId?: string;
  sourceFileName: string;
  mimeType: "application/pdf";
  sizeBytes: number;
  documentBase64: string;
  pdfText?: string;
}

