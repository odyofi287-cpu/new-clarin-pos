import express from "express";
import helmet from "helmet";
import cors from "cors";
import dotenv from "dotenv";
import { initDb } from "./db.js";
import authRoutes from "./routes/auth.js";
import deliveryRoutes from "./routes/deliveries.js";
import productRoutes from "./routes/products.js";
import dashboardRoutes from "./routes/dashboard.js";
import reportsRoutes from "./routes/reports.js";
import salesRoutes from "./routes/sales.js";
import vendorReturnsRoutes from "./routes/vendorReturns.js";
import userRoutes from "./routes/users.js";
import { authMiddleware } from "./middleware/auth.js";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { subscribeToDataChanges } from "./events.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const db = initDb();

app.use(helmet());
const corsOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === "production" ? false : true);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "5mb" }));
// Simple request logger for debugging API routing issues
app.use((req, res, next) => {
  const loggedUrl = req.originalUrl.replace(/([?&])token=[^&]+/i, "$1token=[redacted]");
  console.log(`[REQ] ${req.method} ${loggedUrl}`);
  next();
});
app.use((req, res, next) => {
  req.db = db;
  next();
});

app.use(async (req, res, next) => {
  try {
    await db.ready;
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    database: db.pool ? "postgresql" : "sqlite",
  });
});

app.get("/api/events", authMiddleware, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const sendChange = (change) => res.write(`event: data-change\ndata: ${JSON.stringify(change)}\n\n`);
  const unsubscribe = subscribeToDataChanges(sendChange);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);
  req.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/products", authMiddleware, productRoutes);
app.use("/api/deliveries", authMiddleware, deliveryRoutes);
app.use("/api/dashboard", authMiddleware, dashboardRoutes);
app.use("/api/reports", authMiddleware, reportsRoutes);
app.use("/api/sales", authMiddleware, salesRoutes);
app.use("/api/vendor-returns", authMiddleware, vendorReturnsRoutes);
app.use("/api/users", authMiddleware, userRoutes);

// Serve client SPA when built into a `dist` folder adjacent to the server
try {
  const serverDist = path.join(__dirname, 'dist');
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  const distPath = fs.existsSync(serverDist) ? serverDist : fs.existsSync(clientDist) ? clientDist : null;

  if (distPath) {
    app.use(express.static(distPath));
    app.get('/*splat', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    console.warn('SPA dist folder not found at', serverDist, 'or', clientDist);
  }
} catch (err) {
  console.warn('Error configuring static SPA serving', err && err.message);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
