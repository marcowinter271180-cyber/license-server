import "dotenv/config"; // 🔥 MUSS GANZ OBEN STEHEN
import express from "express";
import cors from "cors";
import { validateLicense, createLicense } from "./licenseController";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/license/validate", validateLicense);
app.post("/api/license/create",   createLicense);   // ← neu

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
