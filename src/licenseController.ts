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

export async function validateLicense(req: Request, res: Response): Promise<void> {
  try {
    const { licenseKey, deviceId } = req.body as {
      licenseKey?: string;
      deviceId?:   string;
    };

    if (!licenseKey || typeof licenseKey !== "string") {
      res.status(400).json({ valid: false, reason: "NO_LICENSE_KEY" });
      return;
    }

    const normalizedDevice = deviceId?.trim() || null;

    const { data, error } = await supabase
      .from("licenses")
      .select("id, code, module, activated, expires_at, device_id, activated_at")
      .eq("code", licenseKey)
      .limit(1)
      .maybeSingle() as { data: LicenseRow | null; error: { message: string } | null };

    if (error) {
      console.error("SUPABASE ERROR:", error);
      res.status(500).json({ valid: false, reason: "DB_ERROR" });
      return;
    }

    if (!data) {
      res.status(404).json({ valid: false, reason: "NOT_FOUND" });
      return;
    }

    // Ablaufprüfung
    if (data.expires_at) {
      const expires = new Date(data.expires_at).getTime();
      if (Number.isNaN(expires)) {
        res.status(500).json({ valid: false, reason: "INVALID_DATE" });
        return;
      }
      if (Date.now() >= expires) {
        res.json({ valid: false, reason: "EXPIRED" });
        return;
      }
    }

    // Auto-Aktivierung: frische Lizenz (activated=false, device_id=null)
    if (!data.activated && !data.device_id) {
      const { error: activateErr } = await supabase
        .from("licenses")
        .update({
          activated:    true,
          device_id:    normalizedDevice,
          activated_at: new Date().toISOString(),
        })
        .eq("id", data.id);

      if (activateErr) {
        console.error("ACTIVATION ERROR:", activateErr);
        res.status(500).json({ valid: false, reason: "ACTIVATION_FAILED" });
        return;
      }

      res.json({ valid: true, module: data.module, expiresAt: data.expires_at ?? null });
      return;
    }

    // Manuell deaktiviert
    if (!data.activated) {
      res.json({ valid: false, reason: "INACTIVE" });
      return;
    }

    // Gerätebindung prüfen
    if (data.device_id && normalizedDevice && data.device_id !== normalizedDevice) {
      res.json({ valid: false, reason: "DEVICE_MISMATCH" });
      return;
    }

    // Gerät binden (falls noch nicht gesetzt)
    if (!data.device_id && normalizedDevice) {
      const { error: bindErr } = await supabase
        .from("licenses")
        .update({ device_id: normalizedDevice })
        .eq("id", data.id)
        .is("device_id", null);

      if (bindErr) console.error("DEVICE BIND ERROR:", bindErr);
    }

    res.json({ valid: true, module: data.module, expiresAt: data.expires_at ?? null });

  } catch (err) {
    console.error("VALIDATE ERROR:", err);
    res.status(500).json({ valid: false, reason: "SERVER_ERROR" });
  }
}

// ─── Gerätewechsel beantragen (Kundenfunktion) ────────────────────────────────

export async function requestReset(req: Request, res: Response): Promise<void> {
  try {
    const { licenseKey } = req.body as { licenseKey?: string };

    // Immer gleiche Erfolgsantwort bei fehlender Eingabe — kein Info-Leak
    if (!licenseKey || typeof licenseKey !== "string") {
      res.json({ success: true });
      return;
    }

    const { data, error } = await supabase
      .from("licenses")
      .select("id, activated, reset_requested_at")
      .eq("code", licenseKey.trim())
      .limit(1)
      .maybeSingle() as { data: { id: number; activated: boolean; reset_requested_at: string | null } | null; error: { message: string } | null };

    if (error) {
      console.error("RESET REQUEST DB ERROR:", error);
      // Stille Antwort — kein internes Detail nach außen
      res.json({ success: true });
      return;
    }

    // Nicht gefunden oder nicht aktiviert: stille Antwort (kein Existenz-Leak)
    if (!data || !data.activated) {
      res.json({ success: true });
      return;
    }

    // Bereits angefragt
    if (data.reset_requested_at) {
      res.json({ success: false, alreadyRequested: true });
      return;
    }

    const { error: updateErr } = await supabase
      .from("licenses")
      .update({ reset_requested_at: new Date().toISOString() })
      .eq("id", data.id);

    if (updateErr) {
      console.error("RESET SET ERROR:", updateErr);
      res.json({ success: true }); // Stille Antwort
      return;
    }

    res.json({ success: true });

  } catch (err) {
    console.error("REQUEST RESET ERROR:", err);
    res.json({ success: true }); // Stille Antwort
  }
}
