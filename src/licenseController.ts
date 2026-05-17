import type { Request, Response } from "express";
import { supabase } from "./supabaseClient";

const RESET_WAIT_HOURS = 48;

type LicenseRow = {
  id:                  number;
  code:                string;
  module:              string;
  activated:           boolean;
  expires_at:          string | null;
  device_id:           string | null;
  activated_at:        string | null;
  reset_requested_at:  string | null;
  kundenname:          string | null;
  duration:            string | null;
};

// ─── Hilfsfunktion: E-Mail via Resend senden ─────────────────────────────────
// Sendet eine einfache HTML-Mail. Wenn RESEND_API_KEY nicht gesetzt ist,
// wird nur geloggt – kein Absturz.

async function sendResetEmail(license: LicenseRow): Promise<void> {
  const apiKey    = process.env.RESEND_API_KEY;
  const adminMail = process.env.ADMIN_EMAIL || "marco@wiker-tools.de";
  const fromMail  = process.env.FROM_EMAIL  || "noreply@vermiet-es.de";

  if (!apiKey) {
    console.warn("RESEND_API_KEY nicht gesetzt – E-Mail wird nicht gesendet.");
    return;
  }

  const html = `
    <h2 style="font-family:sans-serif">🔑 Gerätewechsel-Anfrage</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#666">Lizenzcode:</td><td><strong>${license.code}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Kunde:</td><td>${license.kundenname ?? "(unbekannt)"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Modul:</td><td>${license.module} · ${license.duration ?? ""}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Beantragt:</td><td>${new Date().toLocaleString("de-DE")}</td></tr>
    </table>
    <p style="font-family:sans-serif;margin-top:16px">
      Nach <strong>${RESET_WAIT_HOURS} Stunden</strong> wird der Reset automatisch genehmigt.<br>
      Du kannst ihn früher genehmigen oder ablehnen im Admin-Panel (Strg+Shift+F9).
    </p>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    fromMail,
        to:      adminMail,
        subject: `🔑 Gerätewechsel beantragt – ${license.code}`,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("Resend-Fehler:", res.status, body);
    } else {
      console.log("Reset-E-Mail gesendet an", adminMail);
    }
  } catch (err) {
    console.error("E-Mail konnte nicht gesendet werden:", err);
  }
}

// ─── Lizenz validieren ────────────────────────────────────────────────────────

export async function validateLicense(req: Request, res: Response) {
  try {
    const { licenseKey, deviceId } = req.body as {
      licenseKey?: string;
      deviceId?:   string;
    };

    console.log("LICENSE CHECK:", licenseKey, "| DEVICE:", deviceId);

    if (!licenseKey || typeof licenseKey !== "string") {
      return res.status(400).json({ valid: false, reason: "NO_LICENSE_KEY" });
    }

    const normalizedDeviceId = deviceId?.trim() || null;

    const { data, error } = await supabase
      .from("licenses")
      .select("id, code, module, activated, expires_at, device_id, activated_at, reset_requested_at, kundenname, duration")
      .eq("code", licenseKey)
      .limit(1)
      .maybeSingle<LicenseRow>();

    if (error) {
      console.error("SUPABASE ERROR:", error);
      return res.status(500).json({ valid: false, reason: "DB_ERROR" });
    }

    if (!data) {
      return res.status(404).json({ valid: false, reason: "NOT_FOUND" });
    }

    console.log("DB RESULT:", data);

    // ── Auto-Reset nach 48h ───────────────────────────────────────────────────
    if (data.reset_requested_at) {
      const hoursElapsed =
        (Date.now() - new Date(data.reset_requested_at).getTime()) / (1000 * 60 * 60);

      if (hoursElapsed >= RESET_WAIT_HOURS) {
        console.log("AUTO-RESET nach 48h:", licenseKey);
        await supabase
          .from("licenses")
          .update({
            device_id:          null,
            activated:          false,
            activated_at:       null,
            reset_requested_at: null,
          })
          .eq("id", data.id);

        // Lizenz ist zurückgesetzt – Nutzer muss auf neuem Gerät neu aktivieren
        return res.json({ valid: false, reason: "RESET_COMPLETED" });
      }
    }

    // ── Ablaufprüfung ─────────────────────────────────────────────────────────
    if (data.expires_at) {
      const now     = Date.now();
      const expires = new Date(data.expires_at).getTime();
      if (Number.isNaN(expires)) {
        return res.status(500).json({ valid: false, reason: "INVALID_DATE" });
      }
      if (now >= expires) {
        return res.json({ valid: false, reason: "EXPIRED" });
      }
    }

    // ── Auto-Aktivierung beim ersten Einlösen ─────────────────────────────────
    if (!data.activated && !data.device_id) {
      console.log("AUTO-ACTIVATING:", licenseKey, "for device:", normalizedDeviceId);

      const { error: activateError } = await supabase
        .from("licenses")
        .update({
          activated:    true,
          device_id:    normalizedDeviceId,
          activated_at: new Date().toISOString(),
        })
        .eq("id", data.id);

      if (activateError) {
        console.error("ACTIVATION ERROR:", activateError);
        return res.status(500).json({ valid: false, reason: "ACTIVATION_FAILED" });
      }

      console.log("LICENSE ACTIVATED:", licenseKey);
      return res.json({
        valid:     true,
        module:    data.module,
        expiresAt: data.expires_at ?? null,
      });
    }

    // Manuell deaktiviert
    if (!data.activated) {
      return res.json({ valid: false, reason: "INACTIVE" });
    }

    // Device-Mismatch
    if (data.device_id && normalizedDeviceId && data.device_id !== normalizedDeviceId) {
      return res.json({ valid: false, reason: "DEVICE_MISMATCH" });
    }

    // Device binden
    if (!data.device_id && normalizedDeviceId) {
      const { error: updateError } = await supabase
        .from("licenses")
        .update({ device_id: normalizedDeviceId })
        .eq("id", data.id)
        .is("device_id", null);

      if (updateError) {
        console.error("DEVICE SAVE ERROR:", updateError);
      } else {
        console.log("DEVICE REGISTERED:", normalizedDeviceId);
      }
    }

    return res.json({
      valid:     true,
      module:    data.module,
      expiresAt: data.expires_at ?? null,
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ valid: false, reason: "SERVER_ERROR" });
  }
}

// ─── Lizenz erstellen (Admin) ─────────────────────────────────────────────────

function generateLicenseCode(module: string, duration: string): string {
  const mod  = module.toUpperCase().slice(0, 8);
  const dur  = duration === "monthly" ? "M" : duration === "yearly" ? "Y" : "L";
  const rand = Math.random().toString(36).toUpperCase().slice(2, 8);
  return `VT-${mod}-${dur}-${rand}`;
}

function calcExpiresAt(duration: string): string | null {
  if (duration === "lifetime") return null;
  const now = new Date();
  if (duration === "monthly") now.setMonth(now.getMonth() + 1);
  else if (duration === "yearly") now.setFullYear(now.getFullYear() + 1);
  return now.toISOString();
}

export async function createLicense(req: Request, res: Response) {
  try {
    const { module, duration, admin_key } = req.body as {
      module?:    string;
      duration?:  string;
      admin_key?: string;
    };

    const expectedKey = process.env.ADMIN_KEY;
    if (!expectedKey) {
      console.error("ADMIN_KEY nicht in Umgebungsvariablen gesetzt!");
      return res.status(500).json({ error: "Server-Konfigurationsfehler." });
    }
    if (!admin_key || admin_key !== expectedKey) {
      console.warn("Ungültiger Admin-Key:", admin_key);
      return res.status(401).json({ error: "Ungültiger Admin-Key." });
    }

    const validModules   = ["property", "nk", "complete"];
    const validDurations = ["monthly", "yearly", "lifetime"];
    if (!module || !validModules.includes(module))
      return res.status(400).json({ error: "Ungültiges Modul." });
    if (!duration || !validDurations.includes(duration))
      return res.status(400).json({ error: "Ungültige Laufzeit." });

    const code      = generateLicenseCode(module, duration);
    const expiresAt = calcExpiresAt(duration);

    console.log("CREATING LICENSE:", code, module, duration, "expires:", expiresAt);

    const { data, error } = await supabase
      .from("licenses")
      .insert({
        code, module, duration,
        activated:  false,
        device_id:  null,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      })
      .select("id, code, module, duration, expires_at")
      .single();

    if (error) {
      console.error("CREATE ERROR:", error);
      return res.status(500).json({ error: "Lizenz konnte nicht erstellt werden." });
    }

    console.log("LICENSE CREATED:", data.code);
    return res.json({
      success: true,
      license: { code: data.code, module: data.module, duration: data.duration, expiresAt: data.expires_at },
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}

// ─── Gerätewechsel beantragen (Nutzer) ───────────────────────────────────────

export async function requestReset(req: Request, res: Response) {
  try {
    const { licenseKey } = req.body as { licenseKey?: string };
    if (!licenseKey) return res.status(400).json({ error: "licenseKey fehlt" });

    const { data: license, error } = await supabase
      .from("licenses")
      .select("id, code, module, duration, activated, device_id, reset_requested_at, kundenname")
      .eq("code", licenseKey.trim())
      .maybeSingle<LicenseRow>();

    if (error || !license)
      return res.status(404).json({ error: "Lizenz nicht gefunden" });
    if (!license.activated)
      return res.status(400).json({ error: "Lizenz nicht aktiv – kein Reset nötig" });
    if (license.reset_requested_at)
      return res.status(409).json({ error: "Reset bereits beantragt", alreadyRequested: true });

    const { error: updateErr } = await supabase
      .from("licenses")
      .update({ reset_requested_at: new Date().toISOString() })
      .eq("id", license.id);

    if (updateErr) return res.status(500).json({ error: "Datenbankfehler" });

    // E-Mail asynchron senden (blockiert Response nicht)
    sendResetEmail(license).catch(console.error);

    console.log("RESET REQUESTED:", licenseKey);
    return res.json({ success: true });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}

// ─── Offene Resets abrufen (Admin) ───────────────────────────────────────────

export async function getPendingResets(req: Request, res: Response) {
  try {
    const adminKey    = process.env.ADMIN_KEY;
    const { admin_key } = req.query as { admin_key?: string };
    if (!adminKey || admin_key !== adminKey)
      return res.status(403).json({ error: "Ungültig" });

    const { data, error } = await supabase
      .from("licenses")
      .select("id, code, module, duration, kundenname, reset_requested_at, activated_at, expires_at")
      .not("reset_requested_at", "is", null)
      .order("reset_requested_at", { ascending: true });

    if (error) return res.status(500).json({ error: "Datenbankfehler" });
    return res.json({ resets: data ?? [] });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}

// ─── Reset genehmigen (Admin) ─────────────────────────────────────────────────

export async function approveReset(req: Request, res: Response) {
  try {
    const { licenseKey, admin_key } = req.body as { licenseKey?: string; admin_key?: string };
    const expectedKey = process.env.ADMIN_KEY;
    if (!expectedKey || admin_key !== expectedKey)
      return res.status(403).json({ error: "Ungültig" });

    const { error } = await supabase
      .from("licenses")
      .update({
        device_id:          null,
        activated:          false,
        activated_at:       null,
        reset_requested_at: null,
      })
      .eq("code", licenseKey ?? "");

    if (error) return res.status(500).json({ error: "Datenbankfehler" });
    console.log("RESET APPROVED:", licenseKey);
    return res.json({ success: true });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}

// ─── Reset ablehnen (Admin) ───────────────────────────────────────────────────

export async function denyReset(req: Request, res: Response) {
  try {
    const { licenseKey, admin_key } = req.body as { licenseKey?: string; admin_key?: string };
    const expectedKey = process.env.ADMIN_KEY;
    if (!expectedKey || admin_key !== expectedKey)
      return res.status(403).json({ error: "Ungültig" });

    // Nur reset_requested_at löschen – Gerät bleibt gesperrt
    const { error } = await supabase
      .from("licenses")
      .update({ reset_requested_at: null })
      .eq("code", licenseKey ?? "");

    if (error) return res.status(500).json({ error: "Datenbankfehler" });
    console.log("RESET DENIED:", licenseKey);
    return res.json({ success: true });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}
