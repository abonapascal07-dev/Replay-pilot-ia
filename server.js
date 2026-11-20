
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Preserve raw request bodies for webhook signature checks
app.use(express.json({
  verify: (req, res, buf) => {
    if (
      req.originalUrl.split("?")[0] === "/webhook" ||
      req.originalUrl.split("?")[0] === "/api/paddle/webhook"
    ) {
      req.rawBody = buf.toString("utf8");
    }
  }
}));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "ReplyPilot AI" });
});

// Website pages
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

for (const page of [
  "chat.html",
  "pricing.html",
  "terms.html",
  "privacy.html",
  "refund.html"
]) {
  app.get("/" + page, (req, res) =>
    res.sendFile(path.join(__dirname, page))
  );
}

// Supabase authentication
async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!token) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    if (!url || !key) {
      return res.status(500).json({ error: "Supabase configuration missing." });
    }

    const response = await fetch(`${url}/auth/v1/user`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return res.status(401).json({ error: "Invalid session." });
    }

    req.user = await response.json();
    req.accessToken = token;
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).json({ error: "Authentication failed." });
  }
}

// Active subscription check
async function requireSubscription(req, res, next) {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(req.user.id)}&select=status,current_period_end&limit=1`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${req.accessToken}`
        }
      }
    );

    if (!response.ok) {
      return res.status(503).json({
        error: "Subscription verification unavailable."
      });
    }

    const rows = await response.json();
    const sub = rows[0];

    const valid =
      sub?.status === "active" &&
      sub.current_period_end &&
      new Date(sub.current_period_end) > new Date();

    if (!valid) {
      return res.status(403).json({
        error: "An active subscription is required."
      });
    }

    next();
  } catch (error) {
    console.error("Subscription error:", error);
    res.status(503).json({ error: "Subscription verification failed." });
  }
}

// Paddle prices
const PADDLE_PRICES = {
  starter: "pri_01m7w1jr9hr6bp5pbr63mvpnem",
  pro: "pri_01m7w1mykq0zezf35s739fsd31",
  enterprise: "pri_01m7w1pwtfn424ymzbm99dedjv"
};

// Create Paddle checkout
app.post("/api/checkout", requireAuth, async (req, res) => {
  try {
    const plan = req.body?.plan;
    const priceId = PADDLE_PRICES[plan];

    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan." });
    }

    if (!process.env.PADDLE_API_KEY) {
      return res.status(500).json({ error: "Paddle API key missing." });
    }

    const response = await fetch("https://api.paddle.com/transactions", {
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
          plan
        }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Paddle error:", result);
      return res.status(502).json({ error: "Paddle checkout failed." });
    }

    const checkoutUrl = result.data?.checkout?.url;

    if (!checkoutUrl) {
      return res.status(502).json({
        error: "Paddle did not return a checkout link."
      });
    }

    res.json({ checkoutUrl });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({ error: "Checkout creation failed." });
  }
});

// ReplyPilot AI chat
app.post("/api/chat", requireAuth, requireSubscription, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "AI API key missing." });
    }

    const history = req.body?.history;

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: "Please enter a message." });
    }

    const customerMessage = history.map(item => {
      const content =
        typeof item.content === "string"
          ? item.content
          : (item.parts || []).map(part => part.text || "").join("");

      const role = item.role === "assistant" ? "Assistant" : "Customer";
      return `${role}: ${content}`;
    }).join("\n");

    if (!customerMessage.trim()) {
      return res.status(400).json({ error: "Empty message." });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        instructions:
          "You are ReplyPilot AI, a professional customer support assistant. Write clear, natural replies. Never invent prices, stock availability, or delivery details. Be honest that you are an AI assistant.",
        input: customerMessage
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("AI API error:", data);
      return res.status(502).json({
        error: data.error?.message || "AI request failed."
      });
    }

    const reply = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n");

    if (!reply) {
      return res.status(502).json({ error: "No AI reply returned." });
    }

    res.json({ reply });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "ReplyPilot could not answer." });
  }
});

// WhatsApp webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token &&
    token === process.env.WHATSAPP_VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// Receive WhatsApp webhook events
app.post("/webhook", (req, res) => {
  const secret = process.env.META_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");

  if (!secret || !signature || !req.rawBody) {
    return res.sendStatus(401);
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.sendStatus(401);
  }

  console.log("WhatsApp webhook event received.");
  res.sendStatus(200);
});

// Paddle webhook signature verification
app.post("/api/paddle/webhook", (req, res) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const header = req.get("Paddle-Signature");

  if (!secret || !header || !req.rawBody) {
    return res.sendStatus(401);
  }

  const parts = Object.fromEntries(
    header.split(";").map(part => part.split("="))
  );

  if (!parts.ts || !parts.h1) {
    return res.sendStatus(401);
  }

  const signedPayload = `${parts.ts}:${req.rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  const a = Buffer.from(parts.h1, "hex");
  const b = Buffer.from(expected, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.sendStatus(401);
  }

  console.log("Verified Paddle webhook event:", req.body?.event_type);
  res.sendStatus(200);
});

// Public chat is not enabled yet
app.post("/api/public-chat", (req, res) => {
  res.status(403).json({
    error: "Public chat is not enabled yet."
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`ReplyPilot AI running on port ${PORT}`);
});
                                 
