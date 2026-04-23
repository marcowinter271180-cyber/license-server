import type { Request, Response } from "express";
import { supabase } from "./supabaseClient";

type LicenseRow = {
  id: number;
  code: string;
  activated: boolean;
  expires_at: string | null;
  device_id: string | null;
};

function normalizeDeviceId(value: unknown): string | null {
  if (!value) return null;

  const v = String(value).trim();

  if (!v || v.toLowerCase() === "null" || v === "") {
    return null;
  }

  return v;
}

export async function validateLicense(req: Request, res: Response) {
  try {
    const { licenseKey, deviceId } = req.body;

    console.log("LICENSE CHECK:", licenseKey);

    if (!licenseKey || typeof licenseKey !== "string") {
      return res.status(400).json({
        valid: false,
        reason: "NO_LICENSE_KEY"
      });
    }

    const normalizedDeviceId = normalizeDeviceId(deviceId);

    const { data, error } = await supabase
      .from("licenses")
      .select("id, code, activated, expires_at, device_id")
      .eq("code", licenseKey)
      .limit(1)
      .maybeSingle<LicenseRow>();

    if (error) {
      console.error("SUPABASE ERROR:", error);
      return res.status(500).json({
        valid: false,
        reason: "DB_ERROR"
      });
    }

    console.log("DB RESULT:", data);

    if (!data) {
      return res.json({
        valid: false,
        reason: "NOT_FOUND"
      });
    }

    if (!data.activated) {
      return res.json({
        valid: false,
        reason: "INACTIVE"
      });
    }

    // Ablaufprüfung
    if (data.expires_at) {
      const now = Date.now();
      const expires = new Date(data.expires_at).getTime();

      console.log("NOW:", new Date(now).toISOString());
      console.log("EXPIRES:", new Date(expires).toISOString());

      if (isNaN(expires) || now >= expires) {
        return res.json({
          valid: false,
          reason: "EXPIRED"
        });
      }
    }

    const dbDeviceId = normalizeDeviceId(data.device_id);

    // Device mismatch prüfen
    if (dbDeviceId && normalizedDeviceId && dbDeviceId !== normalizedDeviceId) {
      return res.json({
        valid: false,
        reason: "DEVICE_MISMATCH"
      });
    }

    // Device setzen (nur wenn noch nicht gesetzt)
    if (!dbDeviceId && normalizedDeviceId) {
      const { error: updateError } = await supabase
        .from("licenses")
        .update({ device_id: normalizedDeviceId })
        .eq("id", data.id)
        .is("device_id", null); // verhindert race overwrite

      if (updateError) {
        console.error("DEVICE SAVE ERROR:", updateError);
      } else {
        console.log("DEVICE REGISTERED:", normalizedDeviceId);
      }
    }

    return res.json({
      valid: true,
      expiresAt: data.expires_at ?? null
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);

    return res.status(500).json({
      valid: false,
      reason: "SERVER_ERROR"
    });
  }
}