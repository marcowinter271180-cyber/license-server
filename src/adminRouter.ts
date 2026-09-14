import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import { supabase } from "./supabaseClient";

// ─── Session-Typ-Erweiterung ──────────────────────────────────────────────────

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
    csrfToken?: string;
  }
}

const router = Router();

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function makeCsrfToken(): string {
  return randomBytes(24).toString("hex");
}

function makeLicenseCode(module: string, duration: string): string {
  const mod = module.toUpperCase().slice(0, 8);
  const dur = duration === "monthly" ? "M" : duration === "yearly" ? "Y" : "L";
  return `VT-${mod}-${dur}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function calcExpiresAt(duration: string): string | null {
  if (duration === "lifetime") return null;
  const d = new Date();
  if (duration === "monthly") d.setMonth(d.getMonth() + 1);
  else if (duration === "yearly") d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

// ─── Rate-Limit Login ─────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Versuche. Bitte 15 Minuten warten." },
});

// ─── Auth-Guard ───────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.authenticated) {
    res.status(401).json({ error: "Nicht authentifiziert." });
    return;
  }
  next();
}

// ─── CSRF-Guard (POST/PUT/DELETE) ─────────────────────────────────────────────
//
// GET-Anfragen sind sicher (keine Zustandsänderung).
// Zustandsändernde Requests erfordern das CSRF-Token aus der Session als
// X-CSRF-Token Header. Da das Token nicht in einem Cookie liegt und Cookies
// SameSite=Strict sind, ist eine Cross-Site-Fälschung nicht möglich.

function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET") { next(); return; }
  const token = req.headers["x-csrf-token"] as string | undefined;
  if (!token || token !== req.session?.csrfToken) {
    res.status(403).json({ error: "Ungültiger CSRF-Token." });
    return;
  }
  next();
}

// ─── Login ───────────────────────────────────────────────────────────────────

router.post("/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { password } = req.body as { password?: string };

  if (!password || typeof password !== "string") {
    res.status(400).json({ error: "Passwort erforderlich." });
    return;
  }

  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    console.error("ADMIN_PASSWORD_HASH nicht gesetzt.");
    res.status(500).json({ error: "Server-Konfigurationsfehler." });
    return;
  }

  try {
    const valid = await bcrypt.compare(password, hash);
    if (!valid) {
      res.status(401).json({ error: "Ungültiges Passwort." });
      return;
    }

    // Session neu generieren verhindert Session-Fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error("SESSION REGENERATE:", err);
        res.status(500).json({ error: "Session-Fehler." });
        return;
      }
      req.session.authenticated = true;
      req.session.csrfToken = makeCsrfToken();
      res.json({ success: true, csrfToken: req.session.csrfToken });
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Interner Fehler." });
  }
});

// ─── CSRF-Token abrufen (nach Seitenneuladen) ─────────────────────────────────

router.get("/csrf-token", requireAuth, (req: Request, res: Response): void => {
  res.json({ csrfToken: req.session.csrfToken });
});

// ─── Logout ──────────────────────────────────────────────────────────────────

router.post("/logout", requireAuth, csrfGuard, (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    if (err) console.error("SESSION DESTROY:", err);
    res.clearCookie("sid");
    res.json({ success: true });
  });
});

// ─── Ab hier: Auth für alle Requests, CSRF für zustandsändernde ───────────────

router.use(requireAuth);

// ─── Lizenz erstellen ─────────────────────────────────────────────────────────

router.post("/api/license/create", csrfGuard, async (req: Request, res: Response): Promise<void> => {
  const { module, duration } = req.body as { module?: string; duration?: string };
  const validModules   = ["property", "nk", "complete"];
  const validDurations = ["monthly", "yearly", "lifetime"];

  if (!module || !validModules.includes(module)) {
    res.status(400).json({ error: "Ungültiges Modul. Erlaubt: property, nk, complete." });
    return;
  }
  if (!duration || !validDurations.includes(duration)) {
    res.status(400).json({ error: "Ungültige Laufzeit. Erlaubt: monthly, yearly, lifetime." });
    return;
  }

  const code      = makeLicenseCode(module, duration);
  const expiresAt = calcExpiresAt(duration);

  try {
    const { data, error } = await supabase
      .from("licenses")
      .insert({ code, module, duration, activated: false, device_id: null, expires_at: expiresAt })
      .select("id, code, module, duration, expires_at")
      .single();

    if (error) {
      console.error("LICENSE CREATE ERROR:", error);
      res.status(500).json({ error: "Lizenz konnte nicht erstellt werden." });
      return;
    }

    res.json({
      success: true,
      license: { code: data.code, module: data.module, duration: data.duration, expiresAt: data.expires_at },
    });
  } catch (err) {
    console.error("CREATE ERROR:", err);
    res.status(500).json({ error: "Interner Fehler." });
  }
});

// ─── Lizenzen auflisten ───────────────────────────────────────────────────────

router.get("/api/licenses", async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from("licenses")
      .select("id, code, module, duration, activated, device_id, activated_at, expires_at, kundenname, reset_requested_at, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("LICENSES LIST ERROR:", error);
      res.status(500).json({ error: "Lizenzen konnten nicht geladen werden." });
      return;
    }

    res.json({ licenses: data ?? [] });
  } catch (err) {
    console.error("LIST ERROR:", err);
    res.status(500).json({ error: "Interner Fehler." });
  }
});

// ─── Lizenz sperren / reaktivieren ───────────────────────────────────────────

router.post("/api/license/toggle", csrfGuard, async (req: Request, res: Response): Promise<void> => {
  const { id, activated } = req.body as { id?: number; activated?: boolean };

  if (typeof id !== "number" || typeof activated !== "boolean") {
    res.status(400).json({ error: "Ungültige Eingaben." });
    return;
  }

  try {
    const { error } = await supabase.from("licenses").update({ activated }).eq("id", id);
    if (error) {
      console.error("TOGGLE ERROR:", error);
      res.status(500).json({ error: "Aktualisierung fehlgeschlagen." });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("TOGGLE ERROR:", err);
    res.status(500).json({ error: "Interner Fehler." });
  }
});

// ─── Reset-Anfragen auflisten ─────────────────────────────────────────────────

router.get("/api/resets", async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from("licenses")
      .select("id, code, module, kundenname, duration, activated_at, expires_at, reset_requested_at")
      .not("reset_requested_at", "is", null)
      .order("reset_requested_at", { ascending: true });

    if (error) {
      console.error("RESETS LIST ERROR:", error);
      res.status(500).json({ error: "Anfragen konnten nicht geladen werden." });
      return;
    }

    res.json({ resets: data ?? [] });
  } catch (err) {
    console.error("RESETS ERROR:", err);
    res.status(500).json({ error: "Interner Fehler." });
  }
});

// ─── Reset genehmigen ────────────────────────────────────────────────────────

router.post("/api/resets/approve", csrfGuard, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.body as { id?: number };

  if (typeof id !== "number") {
    res.status(400).json({ error: "ID erforderlich." });
    return;
  }

  try {
    // Nur Lizenzen mit offener Reset-Anfrage werden zurückgesetzt
    const { error } = await supabase
      .from("licenses")
      .update({ activated: false, device_id: null, reset_requested_at: null })
      .eq("id", id)
      .not("reset_requested_at", "is", null);

    if (error) {
      console.error("RESET APPROVE ERROR:", error);
      res.status(500).json({ error: "Genehmigung fehlgeschlagen." });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("APPROVE ERROR:", err);
    res.status(500).json({ error: "Interner Fehler." });
  }
});

// ─── Reset ablehnen ──────────────────────────────────────────────────────────

router.post("/api/resets/deny", csrfGuard, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.body as { id?: number };

  if (typeof id !== "number") {
    res.status(400).json({ error: "ID erforderlich." });
    return;
  }

  try {
    const { error } = await supabase.from("licenses").update({ reset_requested_at: null }).eq("id", id);

    if (error) {
      console.error("RESET DENY ERROR:", error);
      res.status(500).json({ error: "Ablehnung fehlgeschlagen." });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DENY ERROR:", err);
    res.status(500).json({ error: "Interner Fehler." });
  }
});

export default router;
