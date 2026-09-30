import { Injectable } from "@nestjs/common";
import { PDFDocument } from "pdf-lib";

// Splits a multi-page bundle PDF into one single-page PDF buffer per page,
// so page classification and per-document extraction can each send Gemini
// only the pages that are actually relevant instead of the whole bundle.
@Injectable()
export class PdfPageSplitService {
  async splitPages(pdfBuffer: Buffer): Promise<Buffer[]> {
    const source = await PDFDocument.load(pdfBuffer);
    const pageCount = source.getPageCount();
    const pages: Buffer[] = [];

    for (let i = 0; i < pageCount; i++) {
      const doc = await PDFDocument.create();
      const [copied] = await doc.copyPages(source, [i]);
      doc.addPage(copied);
      const bytes = await doc.save();
      pages.push(Buffer.from(bytes));
    }

    return pages;
  }

  // Extracts a contiguous range of pages as one PDF — used to send a grouped
  // document (which may span several pages) to the rich-extraction call as a
  // single multi-page PDF, preserving continuation joins Gemini can see
  // natively (a line item split across a page break, a total on the next page).
  async extractPageRange(pdfBuffer: Buffer, pageIndices: number[]): Promise<Buffer> {
    const source = await PDFDocument.load(pdfBuffer);
    const doc = await PDFDocument.create();
    const copied = await doc.copyPages(source, pageIndices);
    for (const page of copied) doc.addPage(page);
    const bytes = await doc.save();
    return Buffer.from(bytes);
  }

  async getPageCount(pdfBuffer: Buffer): Promise<number> {
    const source = await PDFDocument.load(pdfBuffer);
    return source.getPageCount();
  }
}
