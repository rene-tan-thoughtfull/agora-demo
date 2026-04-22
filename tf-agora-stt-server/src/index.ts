import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import express from "express";
import cors from "cors";
import sttRouter from "./routes/stt";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/stt", sttRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
