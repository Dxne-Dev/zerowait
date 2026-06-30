import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "API prete. Aucun npm install n'a ete repris a zero pour arriver ici." });
});

app.listen(port, () => {
  console.log(`Serveur lance sur http://localhost:${port}`);
});
