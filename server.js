// server.js
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import * as cheerio from "cheerio";
import "dotenv/config";
import fetch from "node-fetch";
import Parser from "rss-parser";
import cron from "node-cron";
import { classifyArticle } from "./utils/classifier.js";

const NEWSAPI_KEY = process.env.NEWSAPI_KEY;

// 1️⃣ Mongoose Schema
const ArticleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    summary: String,
    body: String,
    lang: { type: String, default: "te" },
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

const Article = mongoose.model("Article", ArticleSchema);

// 2️⃣ Express setup
const app = express();
const port = process.env.PORT || 8000;
app.use(cors());
app.use(express.json());

// 3️⃣ MongoDB connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

// 4️⃣ Helper: Save article with classification
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

// 5️⃣ Combined fetch function
async function fetchNewsAllSources() {
  const savedArticles = [];

  // --- NewsAPI ---
  try {
    const newsApiUrl = `https://newsapi.org/v2/top-headlines?country=in&category=business&apiKey=${NEWSAPI_KEY}`;
    const res = await fetch(newsApiUrl);
    const data = await res.json();

    if (data.articles) {
      for (const item of data.articles) {
        const article = {
          title: item.title,
          summary: item.description,
          body: item.content || item.description,
          source: item.source.name,
          url: item.url,
          publishedAt: new Date(item.publishedAt),
        };
        const saved = await saveArticle(article);
        if (saved) savedArticles.push(saved);
      }
    }
  } catch (err) {
    console.error("NewsAPI error:", err);
  }

  // --- RSS Feed ---
  try {
    const parser = new Parser();
    const feed = await parser.parseURL(
      "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"
    );
    for (const item of feed.items) {
      const article = {
        title: item.title,
        summary: item.contentSnippet,
        body: item.content || item.contentSnippet,
        url: item.link,
        source: "TOI",
        publishedAt: new Date(item.pubDate),
      };
      const saved = await saveArticle(article);
      if (saved) savedArticles.push(saved);
    }
  } catch (err) {
    console.error("RSS error:", err);
  }

  // --- Cheerio Scraper ---
  try {
    const scrapeRes = await fetch("https://www.hindustantimes.com/trending");
    const html = await scrapeRes.text();
    const $ = cheerio.load(html);

    $("article").each(async (i, el) => {
      const title = $(el).find("h2").text().trim();
      const url = $(el).find("a").attr("href");
      const summary = $(el).find("p").text().trim();
      if (title && url) {
        const article = {
          title,
          summary,
          body: summary,
          url,
          source: "HindustanTimes",
          publishedAt: new Date(),
        };
        const saved = await saveArticle(article);
        if (saved) savedArticles.push(saved);
      }
    });
  } catch (err) {
    console.error("Scraper error:", err);
  }

  return savedArticles;
}

// 6️⃣ /fetch-news endpoint
app.get("/fetch-news", async (req, res) => {
  try {
    const savedArticles = await fetchNewsAllSources();
    res.json({
      message: "News fetched successfully",
      count: savedArticles.length,
      articles: savedArticles,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

// Run every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  console.log("Running automated fetch-news job every 30 minutes...");
  try {
    await fetchNewsAllSources();
    console.log("Automated fetch completed");
  } catch (err) {
    console.error("Automated fetch error:", err);
  }
});


// 8️⃣ Start server
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
