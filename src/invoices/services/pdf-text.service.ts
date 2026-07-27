import { Injectable, Logger } from "@nestjs/common";
import pdf from "pdf-parse";

@Injectable()
export class PdfTextService {
  private readonly logger = new Logger(PdfTextService.name);

  async extractPdfTextFromBuffer(buffer: Buffer): Promise<string> {
    try {
      const parsed = await pdf(buffer);
      return parsed.text.trim();
    } catch (err) {
      this.logger.warn(
        `pdf-parse failed (${err instanceof Error ? err.message : "unknown"}). Will fall back to Gemini vision.`
      );
      return "";
    }
  }
}

