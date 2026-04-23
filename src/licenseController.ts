import type { Request, Response } from "express";
import { supabase } from "./supabaseClient";

type LicenseRow = {
  id: number;
  code: string;
  activated: boolean;
  expires_at: string | null;
  device_id: string | null;
};

export async function validateLicense(req: Request, res: Response) {
  try {
    const { licenseKey, deviceId } = req.body as {
      licenseKey?: string;
      deviceId?: string;
    };

    if (!licenseKey || typeof licenseKey !== "string") {
      return res.status(400).json({
        valid: false,
        reason: "NO_LICENSE_KEY",
      });
    }

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({
        valid: false,
        reason: "NO_DEVICE_ID",
      });
    }

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
        reason: "DB_ERROR",
      });
    }

    if (!data) {
      return res.status(404).json({
        valid: false,
        reason: "NOT_FOUND",
      });
    }

    if (!data.activated) {
      return res.json({
        valid: false,
        reason: "INACTIVE",
      });
    }

    if (data.expires_at) {
      const now = Date.now();
      const expires = new Date(data.expires_at).getTime();

      if (Number.isNaN(expires)) {
        console.error("INVALID DATE:", data.expires_at);
        return res.status(500).json({
          valid: false,
          reason: "INVALID_DATE",
        });
      }

      if (now >= expires) {
        return res.json({
          valid: false,
          reason: "EXPIRED",
        });
      }
    }

    // Device Check
    if (data.device_id && data.device_id !== deviceId) {
      return res.json({
        valid: false,
        reason: "DEVICE_MISMATCH",
      });
    }

    // Device Binding (nur wenn noch nicht gesetzt)
    if (!data.device_id) {
      const { error: updateError } = await supabase
        .from("licenses")
        .update({ device_id: deviceId })
        .eq("id", data.id)
        .is("device_id", null); // verhindert race condition

      if (updateError) {
        console.error("DEVICE SAVE ERROR:", updateError);
        return res.status(500).json({
          valid: false,
          reason: "DEVICE_BIND_FAILED",
        });
      }
    }

    return res.json({
      valid: true,
      expiresAt: data.expires_at ?? null,
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);

    return res.status(500).json({
      valid: false,
      reason: "SERVER_ERROR",
    });
  }
}