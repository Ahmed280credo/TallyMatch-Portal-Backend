import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI } from "@google/genai";
import {
  extractionPrompt,
  InvoiceExtractionSchema,
  type ExtractedInvoice
} from "../schemas/invoice-extraction.schema.js";

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(withoutFence);
}

@Injectable()
export class GeminiExtractionService {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.ai = new GoogleGenAI({
      apiKey: this.config.getOrThrow<string>("GOOGLE_GEMINI_API_KEY")
    });
    this.model = this.config.getOrThrow<string>("GEMINI_MODEL");
  }

  async extractFromPdfText(pdfText: string): Promise<ExtractedInvoice> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [{ text: `${extractionPrompt}\n\nInvoice text:\n${pdfText}` }]
        }
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0
      }
    });

    const parsed = parseJsonResponse(response.text ?? "");
    return InvoiceExtractionSchema.parse(parsed);
  }

  async extractFromPdfBase64(base64: string): Promise<ExtractedInvoice> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: base64
              }
            },
            { text: extractionPrompt }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0
      }
    });

    const parsed = parseJsonResponse(response.text ?? "");
    return InvoiceExtractionSchema.parse(parsed);
  }
}

