import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  validateLicense,
  createLicense,
  requestReset,
  getPendingResets,
  approveReset,
  denyReset,
} from "./licenseController";

const app = express();
app.use(cors());
app.use(express.json());

// ── Bestehende Endpoints ──────────────────────────────────────────────────────
app.post("/api/license/validate", validateLicense);
app.post("/api/license/create",   createLicense);

// ── Gerätewechsel-Reset ───────────────────────────────────────────────────────
app.post("/api/license/reset-request",  requestReset);
app.get( "/api/license/pending-resets", getPendingResets);
app.post("/api/license/approve-reset",  approveReset);
app.post("/api/license/deny-reset",     denyReset);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
