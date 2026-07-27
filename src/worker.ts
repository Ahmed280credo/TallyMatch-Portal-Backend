import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { InvoiceWorkerModule } from "./invoices/invoice-worker.module.js";

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "ECONNRESET") return;
  console.error("Uncaught exception", err);
  process.exit(1);
});

async function bootstrapWorker() {
  await NestFactory.createApplicationContext(InvoiceWorkerModule);
}

void bootstrapWorker();

