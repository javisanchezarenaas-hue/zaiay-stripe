const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000);