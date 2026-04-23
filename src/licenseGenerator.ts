import { supabase } from "./supabaseClient";

type LicenseModule = "property" | "nk" | "complete";
type LicenseDuration = "monthly" | "yearly" | "lifetime";

function generateRandom(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function mapDurationShort(duration: LicenseDuration): string {
  switch (duration) {
    case "monthly":
      return "M";
    case "yearly":
      return "Y";
    case "lifetime":
      return "L";
  }
}

function calculateExpiry(duration: LicenseDuration): string | null {
  const now = new Date();

  if (duration === "lifetime") return null;

  if (duration === "monthly") {
    now.setMonth(now.getMonth() + 1);
  }

  if (duration === "yearly") {
    now.setFullYear(now.getFullYear() + 1);
  }

  return now.toISOString();
}

export async function createLicense(
  module: LicenseModule,
  duration: LicenseDuration
) {
  const random = generateRandom();
  const short = mapDurationShort(duration);

  const code = `VT-${module.toUpperCase()}-${short}-${random}`;

  const expiresAt = calculateExpiry(duration);

  const { error } = await supabase.from("licenses").insert({
    code,
    module,
    duration,
    activated: false,
    expires_at: expiresAt,
    device_id: null,
  });

  if (error) {
    console.error("LICENSE CREATE ERROR:", error);
    throw new Error("CREATE_FAILED");
  }

  return {
    code,
    module,
    duration,
    expiresAt,
  };
}