import { BadRequestException, Injectable } from "@nestjs/common";
import { parse } from "csv-parse/sync";

@Injectable()
export class CsvParserService {
  parse(buffer: Buffer): Record<string, string>[] {
    try {
      return parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Record<string, string>[];
    } catch (err) {
      throw new BadRequestException(
        `Failed to parse CSV: ${err instanceof Error ? err.message : "invalid format"}`
      );
    }
  }
}
