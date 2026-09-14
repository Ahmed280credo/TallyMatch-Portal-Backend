import "reflect-metadata";
import { createServer } from "http";
import { NestFactory } from "@nestjs/core";
import { InvoiceWorkerModule } from "./invoices/invoice-worker.module.js";

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "ECONNRESET") return;
  console.error("Uncaught exception", err);
  process.exit(1);
});

// Render's free tier only supports Web Services, which require a bound port for
// health checks. This worker has no HTTP API of its own — this listener exists
// solely to satisfy that health check and is independent of the Nest application.
function startHealthCheckServer() {
  const port = Number(process.env.PORT) || 3001;
  createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("worker alive");
  }).listen(port);
}

async function bootstrapWorker() {
  await NestFactory.createApplicationContext(InvoiceWorkerModule);
}

startHealthCheckServer();
void bootstrapWorker();

