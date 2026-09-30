import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI } from "@google/genai";
import {
  PageClassificationResultSchema,
  pageClassificationPrompt,
  pageClassificationResponseSchema,
  type PageClassificationResult
} from "../../schemas/bundle-extraction.schema.js";

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(withoutFence);
}

// One cheap Gemini call per page, run in parallel — classifying a whole
// bundle in a single call would be cheaper still, but per-page calls keep
// each call's context small (one page's image only) and let a garbled page
// fail independently without corrupting the whole bundle's classification.
@Injectable()
export class BundleClassificationService {
  private readonly logger = new Logger(BundleClassificationService.name);
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.ai = new GoogleGenAI({ apiKey: this.config.getOrThrow<string>("GOOGLE_GEMINI_API_KEY") });
    // Cheaper/faster model for classification if configured; falls back to
    // the main extraction model otherwise.
    this.model = this.config.get<string>("GEMINI_CLASSIFICATION_MODEL") ?? this.config.getOrThrow<string>("GEMINI_MODEL");
  }

  async classifyPage(pagePdfBase64: string): Promise<PageClassificationResult> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "application/pdf", data: pagePdfBase64 } }, { text: pageClassificationPrompt }]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: pageClassificationResponseSchema,
        temperature: 0
      }
    });

    const parsed = parseJsonResponse(response.text ?? "");
    return PageClassificationResultSchema.parse(parsed);
  }

  async classifyPages(pagePdfBuffers: Buffer[]): Promise<PageClassificationResult[]> {
    const results = await Promise.allSettled(
      pagePdfBuffers.map((buf) => this.classifyPage(buf.toString("base64")))
    );

    return results.map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      this.logger.warn(`Page ${i} classification failed, treating as "other": ${result.reason}`);
      return { page_type: "other" as const, document_number: null, confidence: 0 };
    });
  }
}
