import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL fehlt in .env");
}

if (!supabaseAnonKey) {
  throw new Error("SUPABASE_ANON_KEY fehlt in .env");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);