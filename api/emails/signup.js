const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

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

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email is required." });
  }

  try {
    // Check for duplicates
    const existing = await db.collection("signups").where("email", "==", email).limit(1).get();
    if (!existing.empty) {
      return res.status(200).json({ success: true, duplicate: true });
    }

    await db.collection("signups").add({
      email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
