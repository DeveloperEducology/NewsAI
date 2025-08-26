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

// 2️⃣ Mongoose Schema
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




// 7️⃣ Scraping Endpoint
// --- 1️⃣ Scrape endpoint using Puppeteer ---
app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url || "https://www.hindustantimes.com/trending"; // example news URL

  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Set User-Agent to mimic real browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36"
    );

    await page.goto(targetUrl, { waitUntil: "networkidle2" });
    await page.waitFor(2000); // optional wait for JS to load

    // Extract articles
    const articles = await page.evaluate(() => {
      const list = [];
      const items = document.querySelectorAll("article"); // adjust selector as per website

      items.forEach((el) => {
        const titleEl = el.querySelector("h2") || el.querySelector("h3");
        const linkEl = el.querySelector("a");
        const summaryEl = el.querySelector("p");

        if (titleEl && linkEl) {
          list.push({
            title: titleEl.innerText.trim(),
            url: linkEl.href,
            summary: summaryEl ? summaryEl.innerText.trim() : "",
            body: summaryEl ? summaryEl.innerText.trim() : "",
            source: window.location.hostname,
            publishedAt: new Date(),
          });
        }
      });
      return list;
    });

    await browser.close();

    // Save to MongoDB
    for (const article of articles) {
      await Article.updateOne(
        { url: article.url },
        { $setOnInsert: article },
        { upsert: true }
      );
    }

    res.json({
      message: "Scraping completed",
      count: articles.length,
      articles,
    });
  } catch (error) {
    console.error("Scrape error:", error);
    res.status(500).json({ error: "Failed to scrape website" });
  }
});

// --- Combined Fetch News Endpoint (Parallel Version) ---
// --- /fetch-news Endpoint ---
app.get("/fetch-news", async (req, res) => {
  const savedArticles = [];

  try {
    // --- 1️⃣ NewsAPI ---
    const newsApiUrl = `https://newsapi.org/v2/top-headlines?country=in&category=business&apiKey=${NEWSAPI_KEY}`;
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

        const { categories, topCategory } = classifyArticle(
          articleData.title + " " + articleData.body
        );
        articleData.categories = categories;
        articleData.topCategory = topCategory;

        const result = await Article.updateOne(
          { url: articleData.url },
          { $setOnInsert: articleData },
          { upsert: true }
        );

        if (result.upsertedCount > 0) savedArticles.push(articleData);
      }
    }

    // --- 2️⃣ RSS Feed ---
    const parser = new Parser();
    const feed = await parser.parseURL(
      "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"
    );

    for (const item of feed.items) {
      const articleData = {
        title: item.title,
        summary: item.contentSnippet,
        body: item.content || item.contentSnippet,
        url: item.link,
        source: "TOI",
        publishedAt: new Date(item.pubDate),
      };

      const { categories, topCategory } = classifyArticle(
        articleData.title + " " + articleData.body
      );
      articleData.categories = categories;
      articleData.topCategory = topCategory;

      const result = await Article.updateOne(
        { url: articleData.url },
        { $setOnInsert: articleData },
        { upsert: true }
      );

      if (result.upsertedCount > 0) savedArticles.push(articleData);
    }

    // --- 3️⃣ Web Scraper (Example) ---
    const scrapeRes = await fetch("https://www.hindustantimes.com/trending");
    const html = await scrapeRes.text();
    const $ = cheerio.load(html);

    const articles = [];
    $("article").each((i, el) => {
      const title = $(el).find("h2").text().trim();
      const url = $(el).find("a").attr("href");
      const summary = $(el).find("p").text().trim();
      const publishedAt = new Date();

      if (title && url) {
        const articleData = {
          title,
          summary,
          body: summary,
          url,
          source: "Example",
          publishedAt,
        };
        const { categories, topCategory } = classifyArticle(
          title + " " + summary
        );
        articleData.categories = categories;
        articleData.topCategory = topCategory;

        articles.push(articleData);
      }
    });

    for (const articleData of articles) {
      const result = await Article.updateOne(
        { url: articleData.url },
        { $setOnInsert: articleData },
        { upsert: true }
      );
      if (result.upsertedCount > 0) savedArticles.push(articleData);
    }

    res.json({
      message: "News fetched from NewsAPI, RSS, and Scraper",
      count: savedArticles.length,
      articles: savedArticles,
    });
  } catch (error) {
    console.error("Fetch news error:", error);
    res.status(500).json({ error: "Failed to fetch news" });
  }
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
    const articleObject = JSON.parse(generatedText);

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
// POST - Create
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

// GET - Fetch
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

// PUT - Update
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

// DELETE - Remove
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




// 10️⃣ Start server
app.listen(port, () =>
  console.log(`Server running on http://localhost:${port}`)
);
