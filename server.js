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

const NEWSAPI_KEY = "51ab13506c5a43929f34a8139deaaaf6";
const SELF_URL = process.env.SERVER_URL || "https://newsai-8a45.onrender.com";

function cleanHtmlContent(htmlContent) {
  if (!htmlContent) return "";

  // Load the HTML content into cheerio
  const $ = cheerio.load(htmlContent);

  // Get the plain text from the HTML
  let text = $.text();

  // Remove common RSS "read more" placeholders and trim whitespace
  text = text.replace(/\[\s*…\s*\]|\[&#8230;\]/g, "").trim();

  return text;
}

// Centralized RSS URLs list (Telugu + National)
const RSS_URLS = [
  // Telugu News
  "https://www.eenadu.net/rssFeeds",
  "https://ntvtelugu.com/feed",
  "https://www.sakshi.com/rss.xml",
  // "https://www.andhrajyothy.com/rss",
  "https://www.ntnews.com/rss",
  "https://www.manatelangana.news/feed",

  // Google News Telugu
  // "https://news.google.com/rss?hl=te&gl=IN&ceid=IN:te",

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
    media: { type: [String], default: [] },
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
  if (/[\u0C00-\u0C7F]/.test(text)) return "te"; // Telugu unicode range

  // Add any missing Telugu source names to this list
  const teluguSources = [
    "eenadu",
    "sakshi",
    "andhrajyothy",
    "ntnews",
    "manatelangana",
    "google.com/rss?hl=te",
    // Add other sources here, e.g., "vaartha", "prajasakti", "visalaandhra"
  ];

  // The check is case-insensitive, so you just need the core name
  if (source && teluguSources.some((s) => source.toLowerCase().includes(s))) {
    return "te";
  }

  return "en"; // default
}
app.get("/", (req, res) => {
  res.send("Server is awake!");
});

// 🔄 Self-ping every 10 minutes to keep alive
cron.schedule("*/5 * * * *", async () => {
  try {
    const res = await fetch(SELF_URL);
    console.log("Self-ping status:", res.status, new Date());
  } catch (err) {
    console.error("Self-ping failed:", err);
  }
});

// 6️⃣ Helper: Save article with classification
async function saveArticle(articleData) {
  const { categories, topCategory } = classifyArticle(
    articleData.title + " " + (articleData.body || "")
  );
  articleData.categories = categories;
  articleData.topCategory = topCategory;

  const result = await Article.updateOne(
    { url: articleData.url },
    { $setOnInsert: articleData },
    { upsert: true }
  );
  return result.upsertedCount > 0 ? articleData : null;
}

// 7️⃣ Fetch News (NewsAPI + RSS + Scraper)
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
        const articleData = {
          title: item.title,
          summary: item.description,
          body: item.content || item.description,
          source: item.source.name,
          url: item.url,
          publishedAt: new Date(item.publishedAt),
        };

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
            item.contentSnippet || item.description
          );
          const cleanBody = cleanHtmlContent(
            item.content || item.contentSnippet || item.description
          );

          const articleData = {
            title: item.title,
            summary: cleanSummary,
            body: cleanBody,
            url: item.link,
            source: feed.title || "RSS",
            publishedAt: new Date(item.pubDate || Date.now()),
          };

          articleData.lang = detectLanguage(
            articleData.title + " " + (articleData.body || ""),
            articleData.source
          );

          const saved = await saveArticle(articleData);
          if (saved) savedArticles.push(saved);
        }
      }
    }

    // --- Scraper Example (Hindustan Times) ---
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
      const url = $(el).find("a").attr("href");
      const summary = $(el).find("p").text().trim();

      if (title && url) {
        const articleData = {
          title,
          summary,
          body: summary,
          url,
          source: "Hindustan Times",
          publishedAt: new Date(),
        };

        articleData.lang = detectLanguage(
          articleData.title + " " + (articleData.body || ""),
          articleData.source
        );

        const saved = await saveArticle(articleData);
        if (saved) savedArticles.push(saved);
      }
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

app.get("/api/articles", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
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
