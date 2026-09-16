// Deliberately NOT part of src/config/env.validation.ts's global validateEnv —
// SAP B1 integration is optional prep work ahead of live credentials, and
// the app must still boot cleanly without it configured. Defaults point at
// the local mock server (mock-sap-b1/server.ts) so `npm run start:dev` +
// `npm run mock:sap-b1` talk to each other with zero config out of the box.
export interface SapB1Config {
  baseUrl: string;
  companyDB: string;
  userName: string;
  password: string;
}

export function sapB1Config(): SapB1Config {
  return {
    baseUrl: process.env.SAP_B1_BASE_URL ?? "http://localhost:4010/b1s/v1",
    companyDB: process.env.SAP_B1_COMPANY_DB ?? "SPAR_FMCG_TEST",
    userName: process.env.SAP_B1_USERNAME ?? "manager",
    password: process.env.SAP_B1_PASSWORD ?? "mock-password",
  };
}
