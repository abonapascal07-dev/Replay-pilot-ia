
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OpenAI API key is missing."
      });
    }

    const history = req.body.history;

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({
        error: "Please enter a customer message."
      });
    }

    const customerMessage = history
      .flatMap(item => {
        if (typeof item.content === "string") {
          return [item.content];
        }
        return (item.parts || [])
          .map(part => part.text || "");
      })
      .join("\n");

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-6-luna",
          instructions:
            "You are ReplyPilot AI, a helpful customer support assistant. Write clear, natural and professional customer replies in English. Be concise and never invent product availability, prices or delivery details.",
          input: customerMessage
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI API error:", data);
      return res.status(response.status).json({
        error: data.error?.message || "OpenAI request failed."
      });
    }

    const reply = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n");

    if (!reply) {
      throw new Error("No reply was returned.");
    }

    res.json({ reply });

  } catch (error) {
    console.error("ReplyPilot error:", error);
    res.status(500).json({
      error: "ReplyPilot could not generate a reply. Please try again."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`ReplyPilot AI running on port ${PORT}`);
});
