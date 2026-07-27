import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { SupabaseAuthGuard } from "../auth/supabase-auth.guard.js";
import { OrgId } from "../common/decorators/org-id.decorator.js";
import { CsvParserService } from "./csv-parser.service.js";
import { CsvTransformerService } from "./csv-transformer.service.js";
import { ImportService } from "./import.service.js";
import {
  GRN_COLUMN_MAPPING,
  GRN_REQUIRED_FIELDS,
  PO_COLUMN_MAPPING,
  PO_REQUIRED_FIELDS,
} from "./column-mapping.config.js";

const csvFileInterceptor = FileInterceptor("file", {
  storage: memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024 },
});

@Controller("v1/import")
@UseGuards(SupabaseAuthGuard)
export class ImportController {
  constructor(
    private readonly parser: CsvParserService,
    private readonly transformer: CsvTransformerService,
    private readonly importService: ImportService
  ) {}

  @Post("po")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(csvFileInterceptor)
  async importPo(
    @OrgId() orgId: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined
  ) {
    this.assertValid(orgId, file);
    const raw = this.parser.parse(file!.buffer);
    const { rows, skipped } = this.transformer.transform(raw, PO_COLUMN_MAPPING, PO_REQUIRED_FIELDS);
    return this.importService.importPurchaseOrders(orgId!, rows, skipped);
  }

  @Post("grn")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(csvFileInterceptor)
  async importGrn(
    @OrgId() orgId: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined
  ) {
    this.assertValid(orgId, file);
    const raw = this.parser.parse(file!.buffer);
    const { rows, skipped } = this.transformer.transform(raw, GRN_COLUMN_MAPPING, GRN_REQUIRED_FIELDS);
    return this.importService.importGoodsReceiptNotes(orgId!, rows, skipped);
  }

  private assertValid(orgId: string | undefined, file: Express.Multer.File | undefined) {
    if (!orgId || orgId.length < 8) {
      throw new BadRequestException("Missing or invalid x-org-id header");
    }
    if (!file) {
      throw new BadRequestException("Missing multipart file field: file");
    }
    const name = file.originalname.toLowerCase();
    if (!name.endsWith(".csv") && file.mimetype !== "text/csv" && file.mimetype !== "application/vnd.ms-excel") {
      throw new BadRequestException("Only CSV files are accepted (.csv)");
    }
  }
}
