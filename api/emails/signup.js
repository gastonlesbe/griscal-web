const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const ALLOWED_ORIGIN = "https://griscal.app";

// Simple in-memory rate limit: max 5 requests per IP per 60s window
// Note: resets on cold starts, but good enough for basic abuse prevention
const rateLimitMap = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID?.trim(),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL?.trim(),
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.trim().replace(/\\n/g, "\n"),
      }),
    });
  }
  return admin.firestore();
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Rate limiting
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }

  const { email } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email is required." });
  }

  try {
    const db = getDb();

    // Check for duplicates
    const existing = await db.collection("signups").where("email", "==", email).limit(1).get();
    if (!existing.empty) {
      return res.status(200).json({ success: true, duplicate: true });
    }

    await db.collection("signups").add({
      email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"Griscal" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: "You're on the Griscal list!",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#060e10;color:#b8d8d5;border-radius:12px;">
          <h2 style="color:#0ecfbe;font-size:1.4rem;margin-bottom:12px;">You're in! 🎉</h2>
          <p>Thanks for joining Griscal early access.</p>
          <p style="margin-top:12px;">You've locked in <strong style="color:#0ecfbe;">$1.99/month forever</strong> — even if the price goes up.</p>
          <p style="margin-top:12px;color:#5a8a85;font-size:0.85rem;">We'll send you one email when Griscal Plus launches. That's it.</p>
        </div>
      `,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Signup error:", err.message, err.stack);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
