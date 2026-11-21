
const crypto = require("crypto");

const GRAPH_VERSION = "v21.0";
const MAX_HISTORY = 12;
const MAX_CONVERSATIONS = 500;

const conversations = new Map();
const seenMessageIds = new Set();

function isValidSignature(rawBody, signatureHeader) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || !signatureHeader) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);

  return (
    received.length === computed.length &&
    crypto.timingSafeEqual(received, computed)
  );
}

async function generateReply(history) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing in Render.");
  }

  const businessName = process.env.BUSINESS_NAME || "notre entreprise";

  const contents = history.map(message => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }]
  }));

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text:
              `You are the customer support assistant of ${businessName}. ` +
              "Reply to the customer's latest message in the same language they use. " +
              "Be polite and concise. Do not invent prices, stock availability, " +
              "order status or delivery details. If you cannot answer, say that " +
              "a human agent will follow up. Return only the reply text."
          }]
        },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 300
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini API error:", data);
    throw new Error(
      "Gemini API request failed: " +
      (data.error?.message || response.status)
    );
  }

  const reply = (data.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || "")
    .join("\n")
    .trim();

  if (!reply) {
    throw new Error("Gemini returned an empty response.");
  }

  return reply;
}

async function sendText(to, text) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body: text }
      })
    }
  );

  if (!response.ok) {
    throw new Error("WhatsApp send error: " + (await response.text()));
  }
}

async function handleMessage(from, messageId, body) {
  if (seenMessageIds.has(messageId)) return;

  seenMessageIds.add(messageId);
  if (seenMessageIds.size > 1000) seenMessageIds.clear();

  const previous = conversations.get(from) || [];
  const updated = [...previous, { role: "user", content: body }];

  const reply = await generateReply(updated.slice(-MAX_HISTORY));
  if (!reply) return;

  const withReply = [...updated, { role: "assistant", content: reply }];
  conversations.set(from, withReply.slice(-MAX_HISTORY));

  if (conversations.size > MAX_CONVERSATIONS) {
    conversations.delete(conversations.keys().next().value);
  }

  if (process.env.WHATSAPP_AUTO_REPLY === "true") {
    await sendText(from, reply);
    console.log("WhatsApp reply sent to", from);
  } else {
    console.log("WhatsApp draft for", from, ":", reply);
  }
}

async function processPayload(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        if (msg.type !== "text" || !msg.text?.body) continue;

        console.log("WhatsApp message from", msg.from);
        await handleMessage(msg.from, msg.id, msg.text.body.trim());
      }
    }
  }
}

function handleWebhook(req, res) {
  const rawBody = req.body;

  if (
    !Buffer.isBuffer(rawBody) ||
    !isValidSignature(rawBody, req.headers["x-hub-signature-256"])
  ) {
    console.error("WhatsApp: invalid signature");
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    console.error("WhatsApp: invalid JSON");
    return;
  }

  processPayload(payload).catch(error =>
    console.error("WhatsApp processing error:", error.message)
  );
}

module.exports = { handleWebhook };
        
