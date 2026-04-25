import type { Request, Response } from "express";
import { supabase } from "./supabaseClient";

type LicenseRow = {
  id:          number;
  code:        string;
  module:      string;        // ← neu: Modul wird jetzt auch gelesen
  activated:   boolean;
  expires_at:  string | null;
  device_id:   string | null;
  activated_at: string | null;
};

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

    // ► deviceId ist optional – bei erster Aktivierung noch unbekannt
    const normalizedDeviceId = deviceId?.trim() || null;

    // ► module zusätzlich selektieren
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

    // Ablaufprüfung (immer zuerst – auch vor Aktivierung)
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

    // ► AUTO-AKTIVIERUNG: Lizenz noch nicht aktiviert + kein Gerät gebunden
    // → wird beim ersten Einlösen automatisch aktiviert
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

      // ► module in Antwort zurückgeben
      return res.json({
        valid:     true,
        module:    data.module,
        expiresAt: data.expires_at ?? null,
      });
    }

    // Manuell deaktiviert (activated=false aber device_id gesetzt)
    if (!data.activated) {
      return res.json({ valid: false, reason: "INACTIVE" });
    }

    // Device-Mismatch prüfen
    if (data.device_id && normalizedDeviceId && data.device_id !== normalizedDeviceId) {
      return res.json({ valid: false, reason: "DEVICE_MISMATCH" });
    }

    // Device binden falls noch nicht gesetzt
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

    // ► module in Antwort zurückgeben
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
