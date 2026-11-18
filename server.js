const express = require("express");
const path = require("path");

const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const INSTRUCTIONS = "Tu es l'assistant de réponse client d'une petite entreprise. Réponds de façon professionnelle, claire et polie, en français, en tenant compte de toute la conversation précédente.";

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/chat", async (req, res) => {
  try {
    const history = req.body.history;
    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: "Message vide." });
    }

    const response = await ai.models.generateContent({
 model: "gemini-3.8-flash",
      contents: history,
      config: { systemInstruction: INSTRUCTIONS },
    });

    res.json({ reply: response.text });
  } catch (err) {
    console.error("Erreur Gemini :", err);
    res.status(500).json({ error: "Erreur lors de la génération de la réponse." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
