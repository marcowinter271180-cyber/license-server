import type { Request, Response } from "express";
import { supabase } from "./supabaseClient";

type LicenseRow = {
  id:           number;
  code:         string;
  module:       string;
  activated:    boolean;
  expires_at:   string | null;
  device_id:    string | null;
  activated_at: string | null;
};

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
      .select("id, code, module, activated, expires_at, device_id, activated_at")
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

    // Ablaufprüfung
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

    // Auto-Aktivierung beim ersten Einlösen
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

// Hilfsfunktion: zufälligen Lizenzcode erzeugen (z.B. VT-COMPLETE-L-AB12CD)
function generateLicenseCode(module: string, duration: string): string {
  const mod = module.toUpperCase().slice(0, 8);
  const dur = duration === "monthly" ? "M" : duration === "yearly" ? "Y" : "L";
  const rand = Math.random().toString(36).toUpperCase().slice(2, 8);
  return `VT-${mod}-${dur}-${rand}`;
}

// Ablaufdatum berechnen
function calcExpiresAt(duration: string): string | null {
  if (duration === "lifetime") return null;
  const now = new Date();
  if (duration === "monthly") {
    now.setMonth(now.getMonth() + 1);
  } else if (duration === "yearly") {
    now.setFullYear(now.getFullYear() + 1);
  }
  return now.toISOString();
}

export async function createLicense(req: Request, res: Response) {
  try {
    const { module, duration, admin_key } = req.body as {
      module?:    string;
      duration?:  string;
      admin_key?: string;
    };

    // ► Admin-Key direkt gegen Render-Umgebungsvariable prüfen – kein Hash, kein Hardcode
    const expectedKey = process.env.ADMIN_KEY;
    if (!expectedKey) {
      console.error("ADMIN_KEY nicht in Umgebungsvariablen gesetzt!");
      return res.status(500).json({ error: "Server-Konfigurationsfehler." });
    }

    if (!admin_key || admin_key !== expectedKey) {
      console.warn("Ungültiger Admin-Key:", admin_key);
      return res.status(401).json({ error: "Ungültiger Admin-Key." });
    }

    // Eingaben validieren
    const validModules   = ["property", "nk", "complete"];
    const validDurations = ["monthly", "yearly", "lifetime"];

    if (!module || !validModules.includes(module)) {
      return res.status(400).json({ error: "Ungültiges Modul. Erlaubt: property, nk, complete." });
    }
    if (!duration || !validDurations.includes(duration)) {
      return res.status(400).json({ error: "Ungültige Laufzeit. Erlaubt: monthly, yearly, lifetime." });
    }

    const code      = generateLicenseCode(module, duration);
    const expiresAt = calcExpiresAt(duration);

    console.log("CREATING LICENSE:", code, module, duration, "expires:", expiresAt);

    const { data, error } = await supabase
      .from("licenses")
      .insert({
        code,
        module,
        duration,
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
      license: {
        code:      data.code,
        module:    data.module,
        duration:  data.duration,
        expiresAt: data.expires_at,
      },
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}
