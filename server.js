const express = require("express");
const path = require("path");
const crypto = require("crypto");
const whatsapp = require("./whatsapp");

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_ENV = process.env.PADDLE_ENV || "production";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const PLANS = {
  starter: "pri_01m7w1jr9hr6bp5pbr63mvpnem",
  pro: "pri_01m7yspafm8vk7fpyjjr5nv3dg",
  enterprise: "pri_01m7w1pwtfn424ymzbm99dedjv"
};

// Paddle webhook
app.post(
  ["/webhook", "/api/paddle/webhook"],
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.PADDLE_WEBHOOK_SECRET;
      const signature = req.headers["paddle-signature"];

      if (!secret || !signature) {
        return res.status(400).send("Missing webhook signature");
      }

      const parts = Object.fromEntries(
        signature.split(";").map(part => part.split("="))
      );

      const timestamp = parts.ts;
      const receivedSignature = parts.h1;

      if (!timestamp || !receivedSignature) {
        return res.status(400).send("Invalid signature format");
      }

      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
        return res.status(400).send("Expired webhook");
      }

      const signedPayload =
        timestamp + ":" + req.body.toString("utf8");

      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(signedPayload)
        .digest("hex");

      const received = Buffer.from(receivedSignature, "hex");
      const expected = Buffer.from(expectedSignature, "hex");

      if (
        received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)
      ) {
        return res.status(401).send("Invalid signature");
      }

      const event = JSON.parse(req.body.toString("utf8"));

      console.log("Verified Paddle event:", event.event_type);

      const eventType = event.event_type;
      const data = event.data || {};
      const userId = data.custom_data?.supabase_user_id;
      const plan = data.custom_data?.plan || null;
      const status = data.status;

      if (status && userId) {
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        const headers = {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json"
        };

        const patchResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
          {
            method: "PATCH",
            headers: {
              ...headers,
              Prefer: "return=representation"
            },
            body: JSON.stringify({ plan, status })
          }
        );

        const updated = await patchResponse.json();

        if (
          patchResponse.ok &&
          Array.isArray(updated) &&
          updated.length === 0
        ) {
          const insertResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/subscriptions`,
            {
              method: "POST",
              headers: {
                ...headers,
                Prefer: "return=minimal"
              },
              body: JSON.stringify({
                user_id: userId,
                plan,
                status
              })
            }
          );

          if (!insertResponse.ok) {
            console.error(
              "Subscription insert failed:",
              await insertResponse.text()
            );
          }
        } else if (!patchResponse.ok) {
          console.error("Subscription update failed:", updated);
        }

        console.log("Subscription updated:", userId, status);
      }

      return res.status(200).json({ received: true });

    } catch (error) {
      console.error("Paddle webhook error:", error.message);
      return res.status(400).json({ error: "Webhook failed" });
    }
  }
);

// WhatsApp webhook
app.post(
  "/api/whatsapp/webhook",
  express.raw({ type: "application/json" }),
  whatsapp.handleWebhook
);

// JSON middleware
app.use(express.json({ limit: "1mb" }));

// Static website files
app.use(express.static(path.join(__dirname, "public")));

// Main pages
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/pricing", (req, res) => {
  res.sendFile(path.join(__dirname, "pricing.html"));
});

app.get("/checkout", (req, res) => {
  res.sendFile(path.join(__dirname, "checkout.html"));
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

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "ReplyPilot AI" });
});

// Supabase authentication
async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ""
    );

    if (!token) {
      return res.status(401).json({
        error: "Please sign in."
      });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        error: "Supabase server configuration is missing."
      });
    }

    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      const details = await response.text();
      console.error("Supabase authentication error:", details);

      return res.status(401).json({
        error: "Invalid session. Please sign in again."
      });
    }

    req.user = await response.json();
    next();

  } catch (error) {
    console.error("Authentication error:", error.message);

    return res.status(500).json({
      error: "Authentication failed."
    });
  }
}

// Create Paddle checkout
app.post("/api/checkout", requireAuth, async (req, res) => {
  try {
    if (!PADDLE_API_KEY) {
      return res.status(500).json({
        error: "Paddle API key is missing in Render."
      });
    }

    const plan = String(req.body.plan || "").toLowerCase();
    const priceId = PLANS[plan];

    if (!priceId) {
      return res.status(400).json({
        error: "Invalid plan."
      });
    }

    const apiUrl =
      PADDLE_ENV === "sandbox"
        ? "https://sandbox-api.paddle.com"
        : "https://api.paddle.com";

    const transactionResponse = await fetch(
      `${apiUrl}/transactions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          items: [
            {
              price_id: priceId,
              quantity: 1
            }
          ],
          collection_mode: "automatic",
          custom_data: {
            supabase_user_id: req.user.id,
            plan: plan
          }
        })
      }
    );

    const result = await transactionResponse.json();

    if (!transactionResponse.ok) {
      console.error("Paddle API error:", result);

      return res.status(502).json({
        error:
          result.error?.detail ||
          result.error?.message ||
          "Paddle checkout could not be created."
      });
    }

    const checkoutUrl = result.data?.checkout?.url;

    if (!checkoutUrl) {
      console.error("Paddle returned no checkout URL:", result);

      return res.status(502).json({
        error: "Paddle did not return a checkout URL."
      });
    }

    return res.json({
      checkoutUrl: checkoutUrl
    });

  } catch (error) {
    console.error("Checkout error:", error.message);

    return res.status(500).json({
      error: "Checkout failed. Please try again."
    });
  }
});

// AI chat - Gemini
app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Gemini API key is missing in Render."
      });
    }

    const history = Array.isArray(req.body.history)
      ? req.body.history.slice(-20)
      : [];

    const contents = history
      .map(h => {
        const text = (h.parts || [])
          .map(p => p.text || "")
          .join("\n")
          .trim();

        if (!text) return null;

        return {
          role: h.role === "assistant" ? "model" : "user",
          parts: [{ text }]
        };
      })
      .filter(Boolean);

    if (
      !contents.length ||
      !contents.some(message => message.role === "user")
    ) {
      return res.status(400).json({
        error: "Message cannot be empty."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);

      return res.status(502).json({
        error: "Gemini AI request failed. Check Render logs."
      });
    }

    const answer = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("\n")
      .trim();

    if (!answer) {
      console.error("Gemini returned no text:", data);

      return res.status(502).json({
        error: "Gemini returned an empty response."
      });
    }

    return res.json({ reply: answer });

  } catch (error) {
    console.error("Gemini chat error:", error.message);

    return res.status(500).json({
      error: "AI assistant failed."
    });
  }
});

// WhatsApp webhook verification
app.get("/api/whatsapp/webhook", (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    verifyToken &&
    token === verifyToken
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Unknown routes
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found."
  });
});

// Server startup
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ReplyPilot AI running on port ${PORT}`);
});
      
