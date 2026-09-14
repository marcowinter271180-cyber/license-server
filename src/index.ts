// Lädt .env.test wenn NODE_ENV=test, sonst .env.
// dotenv überschreibt keine bereits gesetzten Env-Vars (Standard-Verhalten).
import dotenv from "dotenv";
dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env" });
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { validateLicense, requestReset } from "./licenseController";
import adminRouter from "./adminRouter";

// ─── Startup-Validierung ──────────────────────────────────────────────────────

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SESSION_SECRET", "ADMIN_PASSWORD_HASH"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`FATAL: Umgebungsvariable ${key} fehlt.`);
    process.exit(1);
  }
}

const app = express();

// Render.com terminiert TLS am Edge-Proxy. Ohne trust proxy sehen
// express-rate-limit (req.ip) und req.secure die interne Proxy-Verbindung
// statt der echten Client-IP bzw. des HTTPS-Status.
app.set("trust proxy", 1);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET!,
    name: "sid",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge:   8 * 60 * 60 * 1000, // 8 Stunden
    },
  })
);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "license-server" });
});

// ─── Öffentliche API (Kundenfunktionen) ───────────────────────────────────────

app.post("/api/license/validate", validateLicense);

// Rate-Limit: max. 3 Reset-Anfragen pro Stunde pro IP
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Zu viele Anfragen. Bitte später erneut versuchen." },
});
app.post("/api/license/reset-request", resetLimiter, requestReset);

// ─── Entfernter Endpoint — explizit 404 ──────────────────────────────────────
//
// /api/license/create ist nicht mehr öffentlich erreichbar.
// Lizenz-Erstellung erfolgt ausschließlich über /admin/api/license/create.

app.post("/api/license/create", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Endpoint nicht verfügbar." });
});

// ─── Admin-UI (statische Dateien) ─────────────────────────────────────────────

app.use("/admin/ui", express.static(path.join(__dirname, "../public/admin")));

// ─── Admin-Router (Betreiberfunktionen) ───────────────────────────────────────

app.use("/admin", adminRouter);

// ─── Globaler Fehlerhandler ───────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("UNHANDLED ERROR:", err);
  res.status(500).json({ error: "Interner Serverfehler." });
});

// ─── Server starten ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
