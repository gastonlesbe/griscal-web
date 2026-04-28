const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

function verifySignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured

  const signatureHeader = req.headers["x-signature"];
  if (!signatureHeader) return true; // no signature sent (test tool / some event types)

  const requestId = req.headers["x-request-id"];

  // Parse ts and v1 from "ts=...,v1=..."
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("="))
  );
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  const dataId = req.body?.data?.id ?? "";
  const template = `id:${dataId};request-date:${ts};`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(template)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}

async function getPreapproval(id) {
  const res = await fetch(`https://api.mercadopago.com/preapproval/${id}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`MP API ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!verifySignature(req)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { type, data } = req.body || {};

  if (type !== "subscription_preapproval") {
    return res.status(200).json({ received: true });
  }

  try {
    const preapproval = await getPreapproval(data.id);
    const uid = preapproval.external_reference;

    if (!uid) {
      console.warn("Webhook missing external_reference:", data.id);
      return res.status(200).json({ received: true });
    }

    const isActive = preapproval.status === "authorized";

    await db.collection("plans").doc(uid).set(
      {
        tier: isActive ? "plus" : "free",
        preapprovalId: data.id,
        preapprovalStatus: preapproval.status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`Plan updated: uid=${uid} status=${preapproval.status}`);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
