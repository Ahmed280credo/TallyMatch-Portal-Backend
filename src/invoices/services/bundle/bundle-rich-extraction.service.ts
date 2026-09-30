import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI, type Schema } from "@google/genai";
import {
  RichInvoiceDocumentSchema,
  richInvoiceExtractionPrompt,
  richInvoiceExtractionResponseSchema,
  type RichInvoiceDocument,
  RichPoDocumentSchema,
  richPoExtractionPrompt,
  richPoExtractionResponseSchema,
  type RichPoDocument,
  RichGrnDocumentSchema,
  richGrnExtractionPrompt,
  richGrnExtractionResponseSchema,
  type RichGrnDocument
} from "../../schemas/bundle-extraction.schema.js";
import { PdfPageSplitService } from "./pdf-page-split.service.js";
import { PdfTextService } from "../pdf-text.service.js";
import type { DocumentGroup } from "./bundle-grouping.js";

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(withoutFence);
}

export type ExtractedDocument =
  | { kind: "invoice"; group: DocumentGroup; data: RichInvoiceDocument; pdfText: string; rawResponse: unknown }
  | { kind: "po"; group: DocumentGroup; data: RichPoDocument; pdfText: string; rawResponse: unknown }
  | { kind: "grn"; group: DocumentGroup; data: RichGrnDocument; pdfText: string; rawResponse: unknown };

// One full-quality Gemini vision call per grouped document (never the cheap
// classification model — this is the call that actually has to read
// handwriting, stamps, and struck-through numbers correctly). Vision is
// primary: the PDF pages are always sent as inlineData. pdf-parse's text
// layer is extracted alongside purely as a cross-check input for
// BundleResolutionService — pdf-parse returns empty/sparse text on a scan
// rather than throwing, so it can never be trusted as the primary source the
// way the old single-invoice pipeline used it.
@Injectable()
export class BundleRichExtractionService {
  private readonly logger = new Logger(BundleRichExtractionService.name);
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly pageSplit: PdfPageSplitService,
    private readonly pdfText: PdfTextService
  ) {
    this.ai = new GoogleGenAI({ apiKey: this.config.getOrThrow<string>("GOOGLE_GEMINI_API_KEY") });
    this.model = this.config.getOrThrow<string>("GEMINI_MODEL");
  }

  async extractGroup(bundlePdfBuffer: Buffer, group: DocumentGroup): Promise<ExtractedDocument> {
    const groupPdf = await this.pageSplit.extractPageRange(bundlePdfBuffer, group.page_indices);
    const base64 = groupPdf.toString("base64");
    const pdfText = await this.pdfText.extractPdfTextFromBuffer(groupPdf);

    if (group.document_type === "invoice" || group.document_type === "cash_memo") {
      const raw = await this.callGemini(base64, richInvoiceExtractionPrompt, richInvoiceExtractionResponseSchema);
      return { kind: "invoice", group, data: RichInvoiceDocumentSchema.parse(raw), pdfText, rawResponse: raw };
    }
    if (group.document_type === "po") {
      const raw = await this.callGemini(base64, richPoExtractionPrompt, richPoExtractionResponseSchema);
      return { kind: "po", group, data: RichPoDocumentSchema.parse(raw), pdfText, rawResponse: raw };
    }
    // delivery_note | grn — both extracted with the same GRN schema, since a
    // delivery note and a GRN sheet carry the same information for our
    // purposes (received quantities, stamp).
    const raw = await this.callGemini(base64, richGrnExtractionPrompt, richGrnExtractionResponseSchema);
    return { kind: "grn", group, data: RichGrnDocumentSchema.parse(raw), pdfText, rawResponse: raw };
  }

  async extractAllGroups(bundlePdfBuffer: Buffer, groups: DocumentGroup[]): Promise<ExtractedDocument[]> {
    // Parallel per-document extraction — each group's Gemini call is
    // independent, so a slow/garbled document doesn't block the others.
    const results = await Promise.allSettled(groups.map((g) => this.extractGroup(bundlePdfBuffer, g)));

    const extracted: ExtractedDocument[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        extracted.push(result.value);
      } else {
        this.logger.error(
          `Extraction failed for ${groups[i].document_type} group (pages ${groups[i].page_indices.join(",")}): ${result.reason}`
        );
      }
    });
    return extracted;
  }

  private async callGemini(base64: string, prompt: string, schema: Schema): Promise<unknown> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "application/pdf", data: base64 } }, { text: prompt }]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0
      }
    });

    return parseJsonResponse(response.text ?? "");
  }
}
