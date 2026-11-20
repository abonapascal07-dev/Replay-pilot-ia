
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
  if (
  req.originalUrl === "/api/paddle/webhook" ||
  req.originalUrl === "/webhook"
) {
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
  const PADDLE_PRICES = {
  starter: "pri_01m7w1jr9hr6bp5pbr63mvpnem",
  pro: "pri_01m7w1mykq0zezf35s739fsd31",
  enterprise: "pri_01m7w1lpwtfn424ymzbm09edjv"
};

app.post("/api/checkout", requireAuth, async (req, res) => {
  try {
    const { plan } = req.body || {};
    const priceId = PADDLE_PRICES[plan];

    if (!priceId) {
      return res.status(400).json({ error: "Invalid subscription plan." });
    }

    if (!process.env.PADDLE_API_KEY) {
      return res.status(500).json({ error: "Paddle configuration is missing." });
    }

    const paddleResponse = await fetch("https://api.paddle.com/transactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PADDLE_API_KEY}`
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: "automatic",
        enable_checkout: true,
        custom_data: {
          user_id: req.user.id,
          plan: plan
        }
      })
    });

    const result = await paddleResponse.json();

    if (!paddleResponse.ok) {
      console.error("Paddle checkout error:", result);
      return res.status(502).json({ error: "Unable to create the payment. Please try again." });
    }

    const checkoutUrl = result.data?.checkout?.url;

    if (!checkoutUrl) {
      console.error("Paddle returned no checkout URL:", result);
      return res.status(502).json({ error: "Paddle did not return a checkout link." });
    }

    return res.json({ checkoutUrl });
  } catch (error) {
    console.error("Checkout error:", error);
    return res.status(500).json({ error: "Payment creation failed." });
  }
});
        },
        body: JSON.stringify({
          items: [{ price_id: priceId, quantity: 1 }],
          collection_mode: "automatic",
          enable_checkout: true,
          custom_data: {
            user_id: r
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
