
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === "/api/paddle/webhook") {
      req.rawBody = buf.toString("utf8");
    }
  }
}));


app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Verify the customer's Supabase session
async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");

    if (!token) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: "Supabase configuration is missing." });
    }

    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${token}`
      }
    });

 if (!authResponse.ok) {
  const authError = await authResponse.text();
  console.error("Supabase auth check failed:", authResponse.status, authError);
  return res.status(401).json({
    error: "Supabase rejected the session.",
    details: authError
  });
 }   
  
    req.user = await authResponse.json();
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(500).json({ error: "Authentication failed." });
  }
}
async function requireSubscription(req, res, next) {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(req.user.id)}&select=status,current_period_end&limit=1`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: req.headers.authorization
        }
      }
    );

    if (!response.ok) {
      return res.status(503).json({
        error: "Subscription verification unavailable."
      });
    }

    const subscriptions = await response.json();
    const subscription = subscriptions[0];

    const valid =
      subscription?.status === "active" &&
      subscription.current_period_end &&
      new Date(subscription.current_period_end) > new Date();

    if (!valid) {
      return res.status(403).json({
        error: "An active subscription is required."
      });
    }

    next();
  } catch (error) {
    console.error("Subscription check failed:", error);
    res.status(503).json({
      error: "Subscription verification unavailable."
    });
  }
}
app.post("/api/chat", requireAuth, requireSubscription, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OpenAI API key is missing." });
    }

    const history = req.body.history;

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: "Please enter a customer message." });
    }

  const customerMessage = history
  .map((item) => {
    const text =
      typeof item.content === "string"
        ? item.content
        : (item.parts || []).map((part) => part.text || "").join("");
    const who = item.role === "assistant" ? "ReplyPilot draft" : "Customer";
    return `${who}: ${text}`;
  })
  .join("\n");

    if (!customerMessage.trim()) {
      return res.status(400).json({ error: "Please enter a customer message." });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        instructions: "You are ReplyPilot AI, a helpful customer support assistant. Write clear, natural and professional customer replies. Never invent prices, stock availability, or delivery details If the customer asks who created ReplyPilot AI, answer that ReplyPilot AI was created by Pascal Abona, and steer back to their support question. If the customer asks whether they are talking to a human or an AI, answer honestly that they are talking to an AI assistant..",
        input: customerMessage
      })
    });

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
      return res.status(500).json({ error: "No reply was returned." });
    }

    res.json({ reply });
  } catch (error) {
    console.error("ReplyPilot error:", error);
    res.status(500).json({
      error: "ReplyPilot could not generate a reply. Please try again."
    });
  }
});

app.post("/api/public-chat", async (req, res) => {
  try {
    const message = req.body?.message;

    if (typeof message !== "string" || !message.trim() || message.length > 2000) {
      return res.status(400).json({ error: "Invalid message." });
    }

    // Temporary protection: require a signed-in user.
    // Public access will need rate limits and abuse controls.
    return res.status(403).json({
      error: "Public chat is not enabled yet. Please use the signed-in assistant."
    });
  } catch (error) {
    console.error("Public chat error:", error);
    return res.status(500).json({ error: "Server error." });
  }
});

const PORT = process.env.PORT || 3000;
app.get("/chat.html", (req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});

app.get("/pricing.html", (req, res) => {
  res.sendFile(path.join(__dirname, "pricing.html"));
});

app.get("/terms.html", (req, res) => {
  res.sendFile(path.join(__dirname, "terms.html"));
});

app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "privacy.html"));
});

app.get("/refund.html", (req, res) => {
  res.sendFile(path.join(__dirname, "refund.html"));
});

app.listen(PORT, () => {
  console.log(`ReplyPilot AI running on port ${PORT}`);
});
