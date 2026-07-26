import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";

import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── RATE LIMITERS ──────────────────────────────
// General: 100 requests per 15 min per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Analyze endpoints: 10 requests per 15 min per IP (Gemini API is expensive)
const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many analysis requests, please slow down." },
});

// Sources: 30 requests per 15 min per IP
const sourcesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many source requests, please slow down." },
});

// ── FILE UPLOAD CONFIG ─────────────────────────
const imageFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files are allowed."), false);
  }
  cb(null, true);
};

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFilter,
});

app.use(cors());
app.use(express.json({ limit: "50kb" }));
app.use(generalLimiter);

// ── 1. DEBUG ROUTE ─────────────────────────────
app.get("/list-models", async (req, res) => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch models" });
  }
});

// ── 2. TEXT ANALYSIS ───────────────────────────
app.post("/analyze", analyzeLimiter, async (req, res) => {
  const { text } = req.body;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a fake news detector. Analyze this: "${text}" 
              Respond exactly as:
              Verdict: Real/Fake/Suspicious
              Confidence: [0-100]%
              Reason: [explanation]
              Keyword: [single most relevant search keyword or short phrase (2-3 words max) representing the core subject of the claim, suitable for a news search]`
            }]
          }]
        }),
      }
    );

    const data = await response.json();
    const output = data.candidates?.[0]?.content?.parts?.[0]?.text || null;

    // Extract keyword from Gemini's response
    let keyword = null;
    if (output) {
      const keywordMatch = output.match(/Keyword:\s*(.+)/i);
      keyword = keywordMatch ? keywordMatch[1].trim() : null;
    }

    res.json({ result: output, keyword });
  } catch (err) {
    res.status(500).json({ error: "Server failed" });
  }
});

// ── 3. IMAGE ANALYSIS ──────────────────────────
app.post("/analyze-image", analyzeLimiter, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image" });

  try {
    const base64Image = req.file.buffer.toString("base64");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: req.file.mimetype, data: base64Image } },
              {
                text: `Analyze this image for fake news. Respond exactly as:
                Verdict: Real/Fake/Suspicious
                Confidence: [0-100]%
                Reason: [explanation]
                Keyword: [single most relevant search keyword or short phrase (2-3 words max) representing the core subject, suitable for a news search]`
              }
            ]
          }]
        }),
      }
    );

    const data = await response.json();
   

    const output = data.candidates?.[0]?.content?.parts?.[0]?.text || null;

    // Extract keyword from Gemini's response
    let keyword = null;
    if (output) {
      const keywordMatch = output.match(/Keyword:\s*(.+)/i);
      keyword = keywordMatch ? keywordMatch[1].trim() : null;
    }

    res.json({ result: output, keyword });

  } catch (err) {
    
    res.status(500).json({ error: "Server failed" });
  }
});


// ── 4. RELATED SOURCES ────────────────────────
app.get("/sources", sourcesLimiter, async (req, res) => {
  try {
    const query = req.query.q;

    if (!query || query.trim() === "") {
      return res.status(400).json({ error: "No query provided" });
    }

    // Use the keyword directly as provided by Gemini (no slicing/mangling)
    const keyword = query.trim();

    // Wikipedia
    const wikiRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(keyword)}`
    );
    const wikiData = await wikiRes.json();

    // NewsAPI
    const newsRes = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(keyword)}&pageSize=3&sortBy=relevancy&apiKey=bc129e593ccd469c9256e1b0e5f9339d`
    );
    const newsData = await newsRes.json();

    const results = [];

    // Add Wikipedia
    if (wikiData.title && wikiData.extract) {
      results.push({
        type: "Wikipedia",
        title: wikiData.title,
        snippet: wikiData.extract.slice(0, 120) + "...",
        url: wikiData.content_urls?.desktop?.page || "#"
      });
    }

    // Add News
    if (newsData.articles) {
      newsData.articles.forEach(article => {
        results.push({
          type: "News",
          title: article.title,
          snippet: article.source?.name,
          url: article.url
        });
      });
    }

    res.json(results.slice(0, 5));

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sources" });
  }
});


// ── MULTER ERROR HANDLER ───────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Max 5 MB." });
  }
  if (err.message === "Only image files are allowed.") {
    return res.status(415).json({ error: err.message });
  }
  next(err);
});

// ── 5. SERVE FRONTEND ──────────────────────────
app.use(express.static(path.join(__dirname, "../Front-end/dist")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "../Front-end/dist/index.html"));
});

// ── START SERVER ───────────────────────────────
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export default app;