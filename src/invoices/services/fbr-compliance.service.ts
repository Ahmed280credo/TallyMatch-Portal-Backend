import { Injectable } from "@nestjs/common";
import type { FbrStatus } from "../types/database.js";

export interface FbrComplianceResult {
  vendorName: string;
  ntn: string | null;
  status: FbrStatus;
  message: string;
}

@Injectable()
export class FbrComplianceService {
  validateFBRCompliance(vendorName: string, ntn?: string | null): FbrComplianceResult {
    // Mock FBR check is disabled — all vendors treated as Active
    // TODO: integrate real FBR Active Taxpayer List API
    return {
      vendorName,
      ntn: ntn?.trim() || null,
      status: "Active",
      message: "FBR compliance check bypassed — integration pending."
    };
  }
}

