

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ReplyPilot AI - Pricing</title>

  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 30px 16px;
      background: #0b1020;
      color: white;
      font-family: Arial, sans-serif;
    }

    .container {
      max-width: 1000px;
      margin: auto;
    }

    h1 {
      text-align: center;
      font-size: 36px;
    }

    .subtitle {
      text-align: center;
      color: #aab3c5;
    }

    .plans {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      margin-top: 40px;
    }

    .plan {
      background: #151d32;
      border: 1px solid #293550;
      border-radius: 14px;
      padding: 25px;
    }

    .plan h2 { margin-top: 0; }

    .price {
      font-size: 25px;
      font-weight: bold;
    }

    .plan p { color: #bac4d8; }

    button {
      width: 100%;
      padding: 14px;
      margin-top: 20px;
      border: 0;
      border-radius: 8px;
      background: #5267f5;
      color: white;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
    }

    button:disabled {
      opacity: .5;
      cursor: wait;
    }

    #message {
      margin: 25px auto;
      max-width: 650px;
      text-align: center;
      color: #ffd27a;
      overflow-wrap: anywhere;
    }
  </style>
</head>

<body>
  <main class="container">

    <h1>Choose Your Plan</h1>
    <p class="subtitle">
      Grow your business with ReplyPilot AI.
    </p>

    <div class="plans">

      <section class="plan">
        <h2>Starter</h2>
        <div class="price">Starter Plan</div>
        <p>AI business assistance for your boutique.</p>
        <button onclick="subscribe('starter', this)">
          Choose Starter
        </button>
      </section>

      <section class="plan">
        <h2>Pro</h2>
        <div class="price">Pro Plan</div>
        <p>Advanced AI assistance for growing businesses.</p>
        <button onclick="subscribe('pro', this)">
          Choose Pro
        </button>
      </section>

      <section class="plan">
        <h2>Enterprise</h2>
        <div class="price">Enterprise Plan</div>
        <p>AI assistance for larger businesses.</p>
        <button onclick="subscribe('enterprise', this)">
          Choose Enterprise
        </button>
      </section>

    </div>

    <div id="message" role="status"></div>

  </main>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

  <script>
    const SUPABASE_URL =
      "https://zsrkyikjyrfxbdkipnhu.supabase.co";

    const SUPABASE_PUBLISHABLE_KEY =
      "sb_publishable_z17oqYBS5MKJFEaGH8Rf-w_7UHu4dUs";

    const supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY
    );

    function showMessage(message) {
      document.getElementById("message").textContent = message;
    }

    async function subscribe(plan, button) {
      button.disabled = true;
      showMessage("Checking your login session...");

      try {
        const {
          data: { session },
          error: sessionError
        } = await supabaseClient.auth.getSession();

        if (sessionError) {
          throw new Error(sessionError.message);
        }

        if (!session || !session.access_token) {
          throw new Error("Please sign in again before subscribing.");
        }

        showMessage("Connecting to secure checkout...");

        const response = await fetch("/api/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + session.access_token
          },
          body: JSON.stringify({ plan })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || data.message || "Checkout request failed."
          );
        }

        const checkoutUrl =
          data.checkoutUrl || data.checkout_url || data.url;

        if (!checkoutUrl) {
          throw new Error("The server did not return a checkout URL.");
        }

        if (!checkoutUrl.startsWith("https://")) {
          throw new Error("The checkout URL is not secure.");
        }

        window.location.href = checkoutUrl;

      } catch (error) {
        showMessage("Payment error: " + error.message);
        button.disabled = false;
      }
    }

    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        showMessage("You have been signed out. Please sign in again.");
      }
    });
  </script>
</body>
</html>
        
