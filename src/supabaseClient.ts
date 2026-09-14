import { createClient } from "@supabase/supabase-js";

// ─── Fail-Closed Production-Guard ────────────────────────────────────────────
//
// Production-Zugriff ist ausschließlich auf echten Render-Deployment-Instanzen
// erlaubt. Lokal, in Tests und in CI ist Production nie erreichbar —
// unabhängig von NODE_ENV.
//
// Erkennungslogik (mehrschichtig):
//
//   Signal "Render":  RENDER=true  ODER  RENDER_SERVICE_NAME gesetzt
//                     ODER  RENDER_EXTERNAL_URL gesetzt
//
//   Signal "Prod-URL": SUPABASE_URL enthält den Production-Project-Ref
//
// Guard feuert wenn: KEIN Render-Signal UND Production-Project-Ref erkannt
//
// NODE_ENV allein ist kein Freifahrtschein: NODE_ENV=production lokal
// ohne Render-Signal → Guard feuert.
//
// Staging- und localhost-URLs werden nie blockiert.

const PRODUCTION_PROJECT_REF = "zsnedojhwxlvbnqpxkfk";

function extractProjectRef(url: string): string | undefined {
  return url.match(/\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
}

// Render.com setzt diese Vars bei jeder deployed Instanz — lokal nie vorhanden.
function isRenderDeployment(): boolean {
  return (
    process.env.RENDER === "true" ||
    !!process.env.RENDER_SERVICE_NAME ||
    !!process.env.RENDER_EXTERNAL_URL
  );
}

// ─── Env-Validierung ──────────────────────────────────────────────────────────

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL fehlt in den Umgebungsvariablen.");
}

if (!supabaseKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt in den Umgebungsvariablen.");
}

// ─── Guard-Auslösung ──────────────────────────────────────────────────────────

if (!isRenderDeployment() && extractProjectRef(supabaseUrl) === PRODUCTION_PROJECT_REF) {
  console.error(
    "\n[GUARD] ══════════════════════════════════════════════════════════" +
    "\n[GUARD] FATAL: Lokale/Test-/CI-Ausführung versucht, das Production-" +
    "\n[GUARD]        Supabase-Projekt zu verwenden." +
    "\n[GUARD]" +
    "\n[GUARD]   Production-Ref    : " + PRODUCTION_PROJECT_REF +
    "\n[GUARD]   NODE_ENV          : " + (process.env.NODE_ENV ?? "(nicht gesetzt)") +
    "\n[GUARD]   RENDER            : " + (process.env.RENDER ?? "(nicht gesetzt)") +
    "\n[GUARD]   RENDER_SERVICE_NAME: " + (process.env.RENDER_SERVICE_NAME ?? "(nicht gesetzt)") +
    "\n[GUARD]" +
    "\n[GUARD]   Production-Zugriff ist nur von Render-Deployments erlaubt." +
    "\n[GUARD]   Lokal: .env.test mit localhost:54321 oder Staging-URL verwenden." +
    "\n[GUARD]   Kein Secret-Wert wurde ausgegeben." +
    "\n[GUARD] ══════════════════════════════════════════════════════════\n"
  );
  process.exit(1);
}

// ─── Supabase-Client ──────────────────────────────────────────────────────────
//
// SUPABASE_MOCK=true → In-Memory-Mock (nur NODE_ENV=test / .env.test)
// Andernfalls → echter Supabase-Client mit korrekten Production-Credentials.

// Dynamic require verhindert, dass mockSupabase in Production-Bundles geladen wird.
// Der Cast zu `any` erlaubt den polymorphen Einsatz beider Client-Varianten.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
export const supabase: any =
  process.env.SUPABASE_MOCK === "true"
    ? require("./mockSupabase").createMockSupabaseClient()
    : createClient(supabaseUrl, supabaseKey);
