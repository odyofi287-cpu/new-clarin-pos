import express from "express";
import { requireRole } from "../middleware/auth.js";
import { dbGet, isInMemoryDb } from "./dbCompat.js";
import { reportRange, allTimeSalesRange, salesReport, inventoryReport, deliveryReport, totalSalesReport } from "../reportData.js";
import { buildReportDocument, reportCsv } from "../reportDocument.js";

const router = express.Router();
const loaders = { sales: salesReport, inventory: inventoryReport, "vendor-deliveries": deliveryReport, "total-sales": totalSalesReport };

for (const [mode, load] of Object.entries(loaders)) {
  const roles = mode === "vendor-deliveries" ? ["ADMIN", "STAFF", "VENDOR"] : ["ADMIN", "STAFF"];
  for (const csv of [false, true]) {
    router.get(`/${mode}${csv ? "/csv" : ""}`, requireRole(...roles), async (req, res) => {
      let range;
      const allTime = mode === "total-sales" && req.query.scope === "all-time";
      try { if (!allTime) range = reportRange(req.query); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      try {
        if (allTime) range = await allTimeSalesRange(req.db);
        const data = await load(req.db, range.start, range.end, req.user);
        const account = isInMemoryDb(req.db) ? req.db.users.find((u) => u.id === req.user.user_id)
          : await dbGet(req.db, "SELECT name FROM users WHERE id = $1", [req.user.user_id]);
        const report = buildReportDocument(mode, data, range, { ...req.user, name: account?.name || req.user.name });
        if (allTime) report.period.scope = "all-time";
        res.setHeader("Cache-Control", "no-store");
        if (csv) {
          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${mode}-report-${range.start}-to-${range.end}.csv"`);
          return res.send(reportCsv(report));
        }
        return res.json({ data: mode === "total-sales" ? data.products : data, report });
      } catch (error) {
        console.error(error);
        return res.status(500).json({ error: `Failed to ${csv ? "export" : "load"} ${mode} report` });
      }
    });
  }
}

export default router;
