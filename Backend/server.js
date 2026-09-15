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
  message: {
    error: "Too many requests, please try again later.",
  },
});

// Analyze endpoints: 10 requests per 15 min per IP
const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many analysis requests, please slow down.",
  },
});

// Sources: 30 requests per 15 min per IP
const sourcesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many source requests, please slow down.",
  },
});

// ── FILE UPLOAD CONFIG ─────────────────────────

const imageFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    return cb(
      new Error("Only image files are allowed."),
      false
    );
  }

  cb(null, true);
};

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: imageFilter,
});

// ── MIDDLEWARE ──────────────────────────────────

app.use(cors());

app.use(
  express.json({
    limit: "50kb",
  })
);

app.use(generalLimiter);

// ── GEMINI CONFIG ──────────────────────────────

// Keep your Gemini API key in Vercel Environment Variables:
// GEMINI_API_KEY
//
// Do NOT put the actual key directly inside this file.

const GEMINI_MODEL = "gemini-3.5-flash-lite";

const getGeminiUrl = () => {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
};

// ── 1. DEBUG ROUTE ─────────────────────────────

app.get("/list-models", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured.",
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini List Models Error:", data);

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Failed to fetch Gemini models.",
      });
    }

    res.json(data);

  } catch (err) {
    console.error("List Models Error:", err);

    res.status(500).json({
      error: "Failed to fetch models.",
      details: err.message,
    });
  }
});

// ── 2. TEXT ANALYSIS ───────────────────────────

app.post(
  "/analyze",
  analyzeLimiter,
  async (req, res) => {
    const { text } = req.body;

    // Validate input
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        error: "Text is required.",
      });
    }

    // Check Gemini API key
    if (!process.env.GEMINI_API_KEY) {
      console.error(
        "GEMINI_API_KEY is missing."
      );

      return res.status(500).json({
        error:
          "Gemini API key is not configured on the server.",
      });
    }

    try {
      const response = await fetch(
        getGeminiUrl(),
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `
You are a fake news detection assistant.

Analyze the following claim carefully:

"${text.trim()}"

Respond exactly using this format:

Verdict: Real/Fake/Suspicious
Confidence: [0-100]%
Reason: [short explanation]
Keyword: [single most relevant search keyword or short phrase, maximum 2-3 words]
                    `,
                  },
                ],
              },
            ],
          }),
        }
      );

      const data = await response.json();

      // IMPORTANT:
      // Check if Gemini itself returned an error.
      if (!response.ok) {
        console.error(
          "Gemini API Error:",
          JSON.stringify(data, null, 2)
        );

        return res.status(response.status).json({
          error:
            data?.error?.message ||
            "Gemini API request failed.",
        });
      }

      // Extract Gemini response
      const output =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        null;

      // If Gemini returned no text
      if (!output) {
        console.error(
          "Gemini returned no usable output:",
          JSON.stringify(data, null, 2)
        );

        return res.status(502).json({
          error:
            "Gemini returned no analysis result.",
        });
      }

      // Extract keyword
      let keyword = null;

      const keywordMatch = output.match(
        /Keyword:\s*(.+)/i
      );

      if (keywordMatch) {
        keyword = keywordMatch[1].trim();

        // Remove accidental formatting
        keyword = keyword
          .replace(/\*/g, "")
          .replace(/^["']|["']$/g, "")
          .trim();
      }

      console.log("Analysis successful");

      console.log("Gemini Result:", output);

      console.log("Keyword:", keyword);

      // Return result to frontend
      return res.json({
        result: output,
        keyword,
      });

    } catch (err) {
      console.error(
        "Analyze Server Error:",
        err
      );

      return res.status(500).json({
        error: "Server failed during analysis.",
        details: err.message,
      });
    }
  }
);

// ── 3. IMAGE ANALYSIS ──────────────────────────

app.post(
  "/analyze-image",
  analyzeLimiter,
  upload.single("image"),
  async (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        error: "No image uploaded.",
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      console.error(
        "GEMINI_API_KEY is missing."
      );

      return res.status(500).json({
        error:
          "Gemini API key is not configured on the server.",
      });
    }

    try {

      const base64Image =
        req.file.buffer.toString("base64");

      const response = await fetch(
        getGeminiUrl(),
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            contents: [
              {
                parts: [

                  {
                    inline_data: {
                      mime_type:
                        req.file.mimetype,
                      data: base64Image,
                    },
                  },

                  {
                    text: `
Analyze this image for possible fake or misleading news content.

Respond exactly using this format:

Verdict: Real/Fake/Suspicious
Confidence: [0-100]%
Reason: [short explanation]
Keyword: [single most relevant search keyword or short phrase, maximum 2-3 words]
                    `,
                  },

                ],
              },
            ],
          }),
        }
      );

      const data = await response.json();

      // Check Gemini API response
      if (!response.ok) {
        console.error(
          "Gemini Image API Error:",
          JSON.stringify(data, null, 2)
        );

        return res.status(response.status).json({
          error:
            data?.error?.message ||
            "Gemini image analysis failed.",
        });
      }

      // Extract response
      const output =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        null;

      if (!output) {
        console.error(
          "Gemini returned no image analysis:",
          JSON.stringify(data, null, 2)
        );

        return res.status(502).json({
          error:
            "Gemini returned no image analysis result.",
        });
      }

      // Extract keyword
      let keyword = null;

      const keywordMatch = output.match(
        /Keyword:\s*(.+)/i
      );

      if (keywordMatch) {
        keyword = keywordMatch[1].trim();

        keyword = keyword
          .replace(/\*/g, "")
          .replace(/^["']|["']$/g, "")
          .trim();
      }

      console.log(
        "Image analysis successful"
      );

      console.log(
        "Gemini Image Result:",
        output
      );

      console.log(
        "Keyword:",
        keyword
      );

      return res.json({
        result: output,
        keyword,
      });

    } catch (err) {

      console.error(
        "Image Analysis Server Error:",
        err
      );

      return res.status(500).json({
        error:
          "Server failed during image analysis.",
        details: err.message,
      });
    }
  }
);

// ── 4. RELATED SOURCES ─────────────────────────

app.get(
  "/sources",
  sourcesLimiter,
  async (req, res) => {

    try {

      const query = req.query.q;

      if (
        !query ||
        query.trim() === ""
      ) {
        return res.status(400).json({
          error: "No query provided.",
        });
      }

      const keyword = query.trim();

      // ── Wikipedia ────────────────────────────

      const wikiRes = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          keyword
        )}`
      );

      const wikiData =
        await wikiRes.json();

      // ── NewsAPI ──────────────────────────────

      const newsRes = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(
          keyword
        )}&pageSize=3&sortBy=relevancy&apiKey=${process.env.NEWS_API_KEY}`
      );

      const newsData =
        await newsRes.json();

      const results = [];

      // Add Wikipedia
      if (
        wikiData.title &&
        wikiData.extract
      ) {

        results.push({
          type: "Wikipedia",
          title: wikiData.title,

          snippet:
            wikiData.extract.slice(
              0,
              120
            ) + "...",

          url:
            wikiData.content_urls
              ?.desktop?.page ||
            "#",
        });

      }

      // Add News
      if (
        newsData.articles
      ) {

        newsData.articles.forEach(
          (article) => {

            results.push({
              type: "News",
              title:
                article.title,

              snippet:
                article.source
                  ?.name,

              url:
                article.url,
            });

          }
        );

      }

      return res.json(
        results.slice(0, 5)
      );

    } catch (err) {

      console.error(
        "Sources Error:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch sources.",
        details: err.message,
      });
    }
  }
);

// ── MULTER ERROR HANDLER ───────────────────────

app.use(
  (err, req, res, next) => {

    if (
      err.code ===
      "LIMIT_FILE_SIZE"
    ) {

      return res.status(413).json({
        error:
          "File too large. Max 5 MB.",
      });

    }

    if (
      err.message ===
      "Only image files are allowed."
    ) {

      return res.status(415).json({
        error: err.message,
      });

    }

    console.error(
      "Unhandled Server Error:",
      err
    );

    return res.status(500).json({
      error:
        "Internal server error.",
    });
  }
);

// ── START SERVER ───────────────────────────────

if (
  process.env.NODE_ENV !==
  "production"
) {

  const PORT =
    process.env.PORT || 5000;

  app.listen(
    PORT,
    () => {
      console.log(
        `Server running on port ${PORT}`
      );
    }
  );
}

export default app;
