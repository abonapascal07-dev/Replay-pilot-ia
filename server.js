
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, res, buf) => {
    if (["/webhook", "/api/paddle/webhook"].includes(req.originalUrl.split("?")[0])) {
      req.rawBody = buf.toString("utf8");
    }
  }
}));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "ReplyPilot AI" });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

for (const page of ["chat.html", "pricing.html", "terms.html", "privacy.html", "refund.html"]) {
  app.get("/" + page, (req, res) => res.sendFile(path.join(__dirname, page)));
}

// Supabase authentication
async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!token) return res.status(401).json({ error: "Please sign in first." });
    if (!url || !key) return res.status(500).json({ error: "Supabase configuration missing." });

    const response = await fetch(`${url}/auth/v1/user`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Supabase authentication rejected:", response.status, detail);
      return res.status(401).json({ error: "Invalid session. Please sign in again." });
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
      return res.status(503).json({ error: "Subscription verification unavailable." });
    }

    const rows = await response.json();
    const sub = rows[0];

    const valid = sub?.status === "active" &&
      sub.current_period_end &&
      new Date(sub.current_period_end) > new Date();

    if (!valid) return res.status(403).json({ error: "An active subscription is required." });

    next();
  } catch (error) {
    console.error("Subscription error:", error);
    res.status(503).json({ error: "Subscription verification failed." });
  }
}

// Paddle plans
const PADDLE_PRICES = {
  starter: "pri_01m7w1jr9hr6bp5pbr63mvpnem",
  pro: "pri_01m7w1mykq0zezf35s739fsd31",
  enterprise: "pri_01m7w1pwtfn424ymzbm99dedjv"
};

function getPlan(data) {
  const customPlan = data?.custom_data?.plan;
  if (["starter", "pro", "enterprise"].includes(customPlan)) return customPlan;

  const priceId = data?.items?.[0]?.price?.id;
  return Object.keys(PADDLE_PRICES).find(plan => PADDLE_PRICES[plan] === priceId);
}

// Create Paddle checkout
app.post("/api/checkout", requireAuth, async (req, res) => {
  try {
    const plan = req.body?.plan;
    const priceId = PADDLE_PRICES[plan];

    if (!priceId) return res.status(400).json({ error: "Invalid plan." });
    if (!process.env.PADDLE_API_KEY) return res.status(500).json({ error: "Paddle API key missing." });

    const response = await fetch("https://api.paddle.com/transactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PADDLE_API_KEY}`
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: "automatic",
        custom_data: { user_id: req.user.id, plan }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Paddle error:", result);
      return res.status(502).json({ error: "Paddle checkout failed." });
    }

    const checkoutUrl = result.data?.checkout?.url;

    if (!checkoutUrl) {
      console.error("Paddle response missing checkout URL:", result);
      return res.status(502).json({ error: "Paddle did not return a checkout link." });
    }

    // Return all common URL field names for compatibility with pricing.html
    res.json({
      checkoutUrl,
      checkout_url: checkoutUrl,
      url: checkoutUrl
    });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({ error: "Checkout creation failed." });
  }
});

// ReplyPilot AI chat
app.post("/api/chat", requireAuth, requireSubscription, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "AI API key missing." });

    const history = req.body?.history;
    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: "Please enter a message." });
    }

    const customerMessage = history.map(item => {
      const content = typeof item.content === "string"
        ? item.content
        : (item.parts || []).map(part => part.text || "").join("");

      const role = item.role === "assistant" ? "Assistant" : "Customer";
      return `${role}: ${content}`;
    }).join("\n");

    if (!customerMessage.trim()) return res.status(400).json({ error: "Empty message." });

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        instructions: "You are ReplyPilot AI, a professional customer support assistant. Write clear, natural replies. Never invent prices, stock availability, or delivery details. Be honest that you are an AI assistant.",
        input: customerMessage
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("AI API error:", data);
      return res.status(502).json({ error: data.error?.message || "AI request failed." });
    }

    const reply = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n");

    if (!reply) return res.status(502).json({ error: "No AI reply returned." });

    res.json({ reply });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "ReplyPilot could not answer." });
  }
});

// WhatsApp verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// Receive WhatsApp events
app.post("/webhook", (req, res) => {
  const secret = process.env.META_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");

  if (!secret || !signature || !req.rawBody) return res.sendStatus(401);

  const expected = "sha256=" + crypto.createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);

  console.log("WhatsApp webhook event received.");
  res.sendStatus(200);
});

// Paddle webhook
app.post("/api/paddle/webhook", async (req, res) => {
  try {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    const header = req.get("Paddle-Signature");

    if (!secret || !header || !req.rawBody) return res.sendStatus(401);

    const parts = Object.fromEntries(header.split(";").map(part => {
      const index = part.indexOf("=");
      return [part.slice(0, index), part.slice(index + 1)];
    }));

    if (!parts.ts || !parts.h1) return res.sendStatus(401);

    const expected = crypto.createHmac("sha256", secret)
      .update(`${parts.ts}:${req.rawBody}`)
      .digest("hex");

    const a = Buffer.from(parts.h1, "hex");
    const b = Buffer.from(expected, "hex");

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);

    const eventType = req.body?.event_type;
    const data = req.body?.data;
    const customData = data?.custom_data || {};
    const userId = customData.user_id;
    const plan = getPlan(data);
    const subscriptionId = data?.id;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("Supabase admin configuration missing.");
      return res.sendStatus(500);
    }

    const headers = {
      "Content-Type": "application/json",
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    };

    if (eventType === "subscription.activated" || eventType === "subscription.updated") {
      if (!userId || !plan || !subscriptionId) return res.sendStatus(400);

      const periodEnd = data?.current_billing_period?.ends_at;
      if (!periodEnd) return res.sendStatus(400);

      const lookup = await fetch(
        `${supabaseUrl}/rest/v1/subscriptions?provider_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=id&limit=1`,
        { headers }
      );

      if (!lookup.ok) {
        console.error("Supabase lookup failed:", await lookup.text());
        return res.sendStatus(500);
      }

      const existing = (await lookup.json())[0];

      const record = {
        user_id: userId,
        plan,
        status: data.status || "active",
        payment_provider: "paddle",
        provider_subscription_id: subscriptionId,
        current_period_end: periodEnd
      };

      const saveUrl = existing
        ? `${supabaseUrl}/rest/v1/subscriptions?id=eq.${encodeURIComponent(existing.id)}`
        : `${supabaseUrl}/rest/v1/subscriptions`;

      const saveResponse = await fetch(saveUrl, {
        method: existing ? "PATCH" : "POST",
        headers,
        body: JSON.stringify(record)
      });

      if (!saveResponse.ok) {
        console.error("Supabase save failed:", await saveResponse.text());
        return res.sendStatus(500);
      }
    }

    if (eventType === "subscription.canceled" || eventType === "subscription.paused") {
      if (subscriptionId) {
        const status = eventType === "subscription.canceled" ? "canceled" : "paused";

        const update = await fetch(
          `${supabaseUrl}/rest/v1/subscriptions?provider_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status })
          }
        );

        if (!update.ok) {
          console.error("Supabase cancellation update failed:", await update.text());
          return res.sendStatus(500);
        }
      }
    }

    console.log("Paddle webhook processed:", eventType);
    res.sendStatus(200);
  } catch (error) {
    console.error("Paddle webhook error:", error);
    res.sendStatus(500);
  }
});

// Public chat disabled
app.post("/api/public-chat", (req, res) => {
  res.status(403).json({ error: "Public chat is not enabled yet." });
});

// Start server
app.listen(PORT, () => {
  console.log(`ReplyPilot AI running on port ${PORT}`);
});

