const express = require("express");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/chat", async (req, res) => {
  try {
    const history = req.body.history;

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({
        error: "Please enter a customer message."
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: history,
      config: {
        systemInstruction:
          "You are ReplyPilot AI, a helpful customer support assistant. Write clear, professional replies in English. Never invent product availability, prices, or delivery details."
      }
    });

    res.json({ reply: response.text });

  } catch (error) {
    console.error("Gemini error:", error);

    res.status(500).json({
      error: "ReplyPilot could not generate a reply. Please try again."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`ReplyPilot AI running on port ${PORT}`);
});
