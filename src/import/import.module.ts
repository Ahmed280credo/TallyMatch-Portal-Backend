import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { SupabaseAuthGuard } from "../auth/supabase-auth.guard.js";
import { CsvParserService } from "./csv-parser.service.js";
import { CsvTransformerService } from "./csv-transformer.service.js";
import { ImportService } from "./import.service.js";
import { ImportController } from "./import.controller.js";

@Module({
  imports: [DatabaseModule],
  controllers: [ImportController],
  providers: [CsvParserService, CsvTransformerService, ImportService, SupabaseAuthGuard],
})
export class ImportModule {}
