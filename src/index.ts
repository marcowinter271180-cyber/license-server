import dotenv from "dotenv";
dotenv.config(); // 🔥 MUSS GANZ OBEN STEHEN

import express from "express";
import cors from "cors";
import { validateLicense } from "./licenseController";

const app = express();

app.use(cors());
app.use(express.json());

app.post("/api/license/validate", validateLicense);

app.listen(3001, () => {
  console.log("Server läuft auf http://localhost:3001");
});