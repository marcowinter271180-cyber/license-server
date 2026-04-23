import dotenv from "dotenv";
dotenv.config(); // MUSS ganz oben stehen

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { validateLicense } from "./licenseController";
import { createLicense } from "./licenseGenerator";

const app = express();

// ===== CONFIG =====
const PORT = process.env.PORT || 3001;

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== HEALTH CHECK (wichtig für Render) =====
app.get("/", (_req: Request, res: Response) => {
  return res.json({ status: "ok", service: "license-server" });
});

// ===== LICENSE VALIDATION =====
app.post("/api/license/validate", validateLicense);

// ===== LICENSE CREATION (ADMIN) =====
app.post("/api/license/create", async (req: Request, res: Response) => {
  try {
    const { module, duration } = req.body as {
      module?: "property" | "nk" | "complete";
      duration?: "monthly" | "yearly" | "lifetime";
    };

    if (!module || !duration) {
      return res.status(400).json({
        success: false,
        error: "INVALID_INPUT",
      });
    }

    const license = await createLicense(module, duration);

    return res.json({
      success: true,
      license,
    });

  } catch (err) {
    console.error("CREATE LICENSE ERROR:", err);

    return res.status(500).json({
      success: false,
      error: "CREATE_FAILED",
    });
  }
});

// ===== GLOBAL ERROR HANDLER =====
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("GLOBAL ERROR:", err);

  return res.status(500).json({
    success: false,
    error: "SERVER_ERROR",
  });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});