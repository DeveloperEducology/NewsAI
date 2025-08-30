// server.js
// 1️⃣ Import necessary packages
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import * as cheerio from "cheerio";
import "dotenv/config";
import fetch from "node-fetch";
import puppeteer from "puppeteer";
import cron from "node-cron";
import Parser from "rss-parser";
import { classifyArticle } from "./utils/classifier.js";

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "51ab13506c5a43929f34a8139deaaaf6";
const SELF_URL = process.env.SERVER_URL || "https://newsai-8a45.onrender.com";

// --- Utilities ---
function cleanHtmlContent(htmlContent) {
  if (!htmlContent) return "";

  const $ = cheerio.load(htmlContent);
  let text = $.text();
  text = text.replace(/\[\s*…\s*\]|\[&#8230;\]/g, "").trim();
  return text;
}

/**
 * Try extract first image URL from various possible RSS/HTML fields
 */
function extractImageFromItem(item) {
  // 1) Common enclosure
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;

  // 2) urlToImage (some feeds may include it)
  if (item.urlToImage) return item.urlToImage;

  // 3) media:content or media groups
  if (item["media:content"] && item["media:content"].url)
    return item["media:content"].url;
  if (Array.isArray(item.media) && item.media.length > 0) {
    const m = item.media[0];
    if (m.url) return m.url;
    if (m["media:content"] && m["media:content"].url)
      return m["media:content"].url;
  }

  // 4) Look inside content / content:encoded / description / contentSnippet for first <img>
  const htmlSources = [
    item.content,
    item["content:encoded"],
    item.description,
    item.contentSnippet,
    item.summary,
  ];
  for (const src of htmlSources) {
    if (!src) continue;
    const $ = cheerio.load(src);
    const img = $("img").first();
    if (img && img.attr("src")) return img.attr("src");
    // some images use data-src or srcset
    if (img && img.attr("data-src")) return img.attr("data-src");
  }

  // 5) fallback undefined
  return undefined;
}

const FALLBACK_IMAGE =
  "https://media.istockphoto.com/id/1194484769/vector/live-breaking-news-flat-illustration-tv-studio-interior-vector-illustration-television-news.jpg?s=612x612&w=0&k=20&c=sA5xt873Uogwz1m7o-4IhB5x9WKczKLFqFdSwV4yxJU=";

// Centralized RSS URLs list (Telugu + National)
const RSS_URLS = [
  // Telugu News
  "https://ntvtelugu.com/feed",
  "https://www.sakshi.com/rss.xml",
  "https://10tv.in/latest/feed",
  // "https://www.andhrajyothy.com/rss",
  "https://www.ntnews.com/rss",
  "https://www.manatelangana.news/feed",

  // Major Indian English News
  "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
  "https://www.thehindu.com/news/national/feeder/default.rss",
  "https://indianexpress.com/feed/",
  "https://feeds.feedburner.com/ndtvnews-latest",
];

// 2️⃣ Mongoose Schema
const ArticleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    summary: String,
    body: String,
    lang: { type: String },
    region: { type: String, default: "AP" },
    source: String,
    imageUrl: String,
    isPublished: { type: Boolean, default: false },
    media: {
      type: [
        {
          type: {
            type: String,
            required: true,
            enum: ["image", "video"],
          },
          src: {
            type: String,
            required: true,
          },
        },
      ],
      default: [
        {
          type: "image",
          src: FALLBACK_IMAGE,
        },
      ],
    },
    publishedAt: { type: Date, required: true },
    url: { type: String, unique: true },
    categories: { type: Map, of: Number, default: {} },
    topCategory: String,
    vecContent: { type: [Number], default: [] },
    blocked: { type: Boolean, default: false },
    boost: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

ArticleSchema.index({ publishedAt: -1 });
ArticleSchema.index({ topCategory: 1 });
ArticleSchema.index({ region: 1 });
ArticleSchema.index({ blocked: 1 });

const Article = mongoose.model("Article", ArticleSchema);

// 3️⃣ Initialize Express app
const app = express();
const port = process.env.PORT || 8000;

// 4️⃣ MongoDB connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected successfully."))
  .catch((err) => console.error("MongoDB connection error:", err));

// 5️⃣ Middleware
const allowedOrigins = [
  "https://vijay-ixl.onrender.com",
  "http://localhost:3000",
  "http://localhost:5173",
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
};
app.use(cors(corsOptions));
app.use(express.json());

function detectLanguage(text, source = "") {
  if (/[\u0C00-\u0C7F]/.test(text)) return "te";
  const teluguSources = [
    "eenadu",
    "sakshi",
    "andhrajyothy",
    "ntnews",
    "manatelangana",
    "google.com/rss?hl=te",
  ];
  if (source && teluguSources.some((s) => source.toLowerCase().includes(s))) {
    return "te";
  }
  return "en";
}
app.get("/", (req, res) => {
  res.send("Server is awake!");
});

// 🔄 Self-ping every 5 minutes to keep alive
cron.schedule("*/5 * * * *", async () => {
  try {
    const res = await fetch(SELF_URL);
    console.log("Self-ping status:", res.status, new Date());
  } catch (err) {
    console.error("Self-ping failed:", err);
  }
});

// ✨ NEW: Helper function to generate content using Gemini for short articles
async function generateContentForArticle(title) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("GEMINI_API_KEY is not set. Skipping content generation.");
    return null;
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  // A specific prompt for generating a news body from a headline
  const prompt = `
    Based on the following headline, write a neutral, informative news article body.
    Headline: "${title}"
    The output MUST be a single JSON object with one key: "body". The body should be a string of a few paragraphs.
  `;

  const requestBody = { contents: [{ parts: [{ text: prompt }] }] };

  try {
    const apiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        console.error(`Gemini API failed with status: ${apiResponse.status}`, errorBody);
        return null;
    }

    const data = await apiResponse.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!generatedText) {
        console.error("No text generated by Gemini.");
        return null;
    }
    
    // Clean up markdown/json backticks if they exist
    const cleanedJsonString = generatedText.replace(/```json/g, "").replace(/```/g, "").trim();
    const articleObject = JSON.parse(cleanedJsonString);

    return articleObject; // Should return { body: "..." }
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    return null;
  }
}


// 6️⃣ Helper: Save article with classification
async function saveArticle(articleData) {
  const { categories, topCategory } = classifyArticle(
    articleData.title + " " + (articleData.body || "")
  );
  articleData.categories = categories;
  articleData.topCategory = topCategory;

  // Ensure imageUrl & media exist (defensive)
  if (
    !articleData.media ||
    !Array.isArray(articleData.media) ||
    articleData.media.length === 0
  ) {
    const fallback = {
      type: "image",
      src: articleData.imageUrl || FALLBACK_IMAGE,
    };
    articleData.media = [fallback];
    articleData.imageUrl = articleData.imageUrl || FALLBACK_IMAGE;
  } else {
    // Ensure imageUrl is set to first media src
    articleData.imageUrl = articleData.imageUrl || articleData.media[0].src;
  }

  const result = await Article.updateOne(
    { url: articleData.url },
    { $setOnInsert: articleData },
    { upsert: true }
  );
  return result.upsertedCount > 0 ? articleData : null;
}

// 7️⃣ Fetch News (NewsAPI + RSS + Scraper)
async function fetchNews() {
  console.log("Running fetchNews...");
  const savedArticles = [];
  const parser = new Parser();

  try {
    // --- NewsAPI ---
    const newsApiUrl = `https://newsapi.org/v2/top-headlines?country=in&category=politics&apiKey=${NEWSAPI_KEY}`;
    const newsApiRes = await fetch(newsApiUrl);
    const newsApiData = await newsApiRes.json();

    if (newsApiData.articles) {
      for (const item of newsApiData.articles) {
        const imageCandidate = item.urlToImage || undefined;

        const articleData = {
          title: item.title || "Untitled",
          summary: item.description || "",
          body: item.content || item.description || "",
          source: item.source?.name || "NewsAPI",
          url: item.url,
          publishedAt: item.publishedAt
            ? new Date(item.publishedAt)
            : new Date(),
          imageUrl: imageCandidate,
          media: imageCandidate ? [{ type: "image", src: imageCandidate }] : [],
        };
        
        // ✨ MODIFIED: Check if body is too short, and if so, generate content with Gemini
        if (articleData.body && articleData.body.length < 150 && articleData.title) {
            console.log(`📝 Body for "${articleData.title}" is short. Attempting to generate content...`);
            const generatedContent = await generateContentForArticle(articleData.title);
            if (generatedContent && generatedContent.body) {
                articleData.body = generatedContent.body;
                console.log(`✅ Successfully generated new body for "${articleData.title}"`);
            } else {
                console.warn(`⚠️ Failed to generate content for "${articleData.title}". Using original short body.`);
            }
        }

        articleData.lang = detectLanguage(
          articleData.title + " " + (articleData.body || ""),
          articleData.source
        );

        const saved = await saveArticle(articleData);
        if (saved) savedArticles.push(saved);
      }
    }

    // --- RSS Feeds (parallel) ---
    const rssFeeds = await Promise.allSettled(
      RSS_URLS.map((url) => parser.parseURL(url))
    );

    for (const result of rssFeeds) {
      if (result.status === "fulfilled") {
        const feed = result.value;
        for (const item of feed.items) {
          const cleanSummary = cleanHtmlContent(
            item.contentSnippet || item.description || ""
          );
          const cleanBody = cleanHtmlContent(
            item.content || item.contentSnippet || item.description || ""
          );
          const extracted = extractImageFromItem(item);

          const articleData = {
            title: item.title || "Untitled",
            summary: cleanSummary,
            body: cleanBody,
            url: item.link || item.guid || "",
            source: feed.title || "RSS",
            publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
            imageUrl: extracted,
            media: extracted ? [{ type: "image", src: extracted }] : [],
          };
          
          // ✨ MODIFIED: Check if body is too short, and if so, generate content with Gemini
          if (articleData.body.length < 150 && articleData.title) {
              console.log(`📝 Body for "${articleData.title}" is short. Attempting to generate content...`);
              const generatedContent = await generateContentForArticle(articleData.title);
              if (generatedContent && generatedContent.body) {
                  articleData.body = generatedContent.body;
                  console.log(`✅ Successfully generated new body for "${articleData.title}"`);
              } else {
                  console.warn(`⚠️ Failed to generate content for "${articleData.title}". Using original short body.`);
              }
          }

          articleData.lang = detectLanguage(
            articleData.title + " " + (articleData.body || ""),
            articleData.source
          );

          const saved = await saveArticle(articleData);
          if (saved) savedArticles.push(saved);
        }
      } else {
        console.warn("One RSS feed failed:", result.reason);
      }
    }

    // --- Scraper Example (Hindustan Times) ---
    try {
      const scrapeRes = await fetch("https://www.hindustantimes.com/trending", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const html = await scrapeRes.text();
      const $ = cheerio.load(html);

      const articleElements = $("article");
      for (const el of articleElements) {
        const title = $(el).find("h2").text().trim();
        let url = $(el).find("a").attr("href");
        if (url && url.startsWith("/"))
          url = `https://www.hindustantimes.com${url}`;
        const summary = $(el).find("p").text().trim();
        const img = $(el).find("img").first();
        let imgUrl = img.attr("src") || img.attr("data-src") || undefined;

        if (title && url) {
          const articleData = {
            title,
            summary,
            body: summary || "",
            url,
            source: "Hindustan Times",
            publishedAt: new Date(),
            imageUrl: imgUrl,
            media: imgUrl ? [{ type: "image", src: imgUrl }] : [],
          };

          articleData.lang = detectLanguage(
            articleData.title + " " + (articleData.body || ""),
            articleData.source
          );

          const saved = await saveArticle(articleData);
          if (saved) savedArticles.push(saved);
        }
      }
    } catch (err) {
      console.warn("Scraper step failed:", err);
    }

    console.log(
      `✅ fetchNews finished. Saved ${savedArticles.length} new articles.`
    );
  } catch (err) {
    console.error("fetchNews error:", err);
  }

  return savedArticles;
}

// 8️⃣ API Endpoints
app.get("/fetch-news", async (req, res) => {
  const articles = await fetchNews();
  res.json({ message: "News fetched", count: articles.length, articles });
});

// 8️⃣ Generate Article Preview (Gemini API)
app.post("/api/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  const apiKey = process.env.GEMINI_API_KEY;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const wrapperPrompt = `
    You are a text processing bot. Follow user's command exactly.
    User command: "${prompt}"
    Output MUST be a single JSON with keys: "title" and "body".
  `;

  const requestBody = { contents: [{ parts: [{ text: wrapperPrompt }] }] };

  try {
    const apiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!apiResponse.ok)
      throw new Error(`Gemini API failed: ${apiResponse.status}`);
    const data = await apiResponse.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const cleanedJsonString = generatedText.replace(/```json/g, "").replace(/```/g, "").trim();
    const articleObject = JSON.parse(cleanedJsonString);

    res.status(200).json({
      title: articleObject.title,
      body: articleObject.body,
      publishedAt: new Date(),
      lang: "te",
      region: "AP",
    });
  } catch (error) {
    console.error("Error generating content:", error);
    res.status(500).json({ error: "Failed to generate content" });
  }
});

// 9️⃣ CRUD Endpoints
app.post("/api/articles", async (req, res) => {
  try {
    const newArticle = new Article(req.body);
    const savedArticle = await newArticle.save();
    res.status(201).json(savedArticle);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save article" });
  }
});

app.get("/api/mobile/articles", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const articles = await Article.find({ isPublished: true })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalArticles = await Article.countDocuments({ isPublished: true });

    res.status(200).json({
      articles,
      currentPage: page,
      totalPages: Math.ceil(totalArticles / limit),
      totalArticles,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

app.get("/api/articles", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const articles = await Article.find()
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);
    const totalArticles = await Article.countDocuments();

    res.status(200).json({
      articles,
      currentPage: page,
      totalPages: Math.ceil(totalArticles / limit),
      totalArticles,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

app.put("/api/articles/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const updatedArticle = await Article.findByIdAndUpdate(id, req.body, {
      new: true,
    });

    if (!updatedArticle)
      return res.status(404).json({ error: "Article not found" });
    res.status(200).json(updatedArticle);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update article" });
  }
});

app.delete("/api/articles/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const deletedArticle = await Article.findByIdAndDelete(id);
    if (!deletedArticle)
      return res.status(404).json({ error: "Article not found" });

    res.status(200).json({ message: "Article deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete article" });
  }
});

// 9️⃣ Cron Job: Every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  console.log("⏰ Cron triggered fetchNews");
  await fetchNews();
});

// 🔟 Start Server
app.listen(port, async () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  await fetchNews(); // run once on startup
});
