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

const NEWSAPI_KEY = "51ab13506c5a43929f34a8139deaaaf6";
const SELF_URL = process.env.SERVER_URL || "https://newsai-8a45.onrender.com";

// --- Utilities ---
function cleanHtmlContent(htmlContent) {
  if (!htmlContent) return "";

  const $ = cheerio.load(htmlContent);
  let text = $.text();
  text = text.replace(/\[\s*…\s*\]|\[&#8230;\]/g, "").trim();
  return text;
}

function calculateJaccardSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const set1 = new Set(text1.toLowerCase().split(/\s+/));
  const set2 = new Set(text2.toLowerCase().split(/\s+/));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

function extractImageFromItem(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item.urlToImage) return item.urlToImage;
  if (item["media:content"] && item["media:content"].url)
    return item["media:content"].url;
  if (Array.isArray(item.media) && item.media.length > 0) {
    const m = item.media[0];
    if (m.url) return m.url;
    if (m["media:content"] && m["media:content"].url)
      return m["media:content"].url;
  }
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
    if (img && img.attr("data-src")) return img.attr("data-src");
  }
  return undefined;
}

const FALLBACK_IMAGE =
  "https://media.istockphoto.com/id/1194484769/vector/live-breaking-news-flat-illustration-tv-studio-interior-vector-illustration-television-news.jpg?s=612x612&w=0&k=20&c=sA5xt873Uogwz1m7o-4IhB5x9WKczKLFqFdSwV4yxJU=";

// ✨ MODIFIED: Using an array of objects for sources with clean names
const RSS_SOURCES = [
  // Telugu News
  { url: "https://ntvtelugu.com/feed", name: "NTV Telugu" },
  { url: "https://tv9telugu.com/feed", name: "TV9 Telugu" },
  {
    url: "https://telugu.hindustantimes.com/rss/andhra-pradesh",
    name: "HT Telugu",
  },
  { url: "https://telugu.hindustantimes.com/rss/telangana", name: "HT Telugu" },
  {
    url: "https://telugu.hindustantimes.com/rss/national-international",
    name: "HT Telugu",
  },
  { url: "https://telugu.hindustantimes.com/rss/sports", name: "HT Telugu" },
  {
    url: "https://telugu.hindustantimes.com/rss/entertainment",
    name: "HT Telugu",
  },
  { url: "https://epaper.eenadu.net/Home/RssFeed", name: "Eenadu" },
  { url: "https://www.sakshi.com/rss.xml", name: "Sakshi" },
  { url: "https://10tv.in/latest/feed", name: "10TV" },
  { url: "https://www.ntnews.com/rss", name: "Namasthe Telangana" },
  { url: "https://www.manatelangana.news/feed", name: "Mana Telangana" },
  // Major Indian English News
  {
    url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    name: "Times of India",
  },
  {
    url: "https://www.thehindu.com/news/national/feeder/default.rss",
    name: "The Hindu",
  },
  { url: "https://indianexpress.com/feed/", name: "Indian Express" },
  { url: "https://feeds.feedburner.com/ndtvnews-latest", name: "NDTV News" },
];

// 2️⃣ Mongoose Schemas & Models
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
    isCreatedBy: { type: String, require: true, default: "rss" },
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

const UserSchema = new mongoose.Schema(
  {
    isAnonymous: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
const User = mongoose.model("User", UserSchema);

const EventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Types.ObjectId, ref: "User", index: true },
    articleId: { type: mongoose.Types.ObjectId, ref: "Article", index: true },
    event: {
      type: String,
      enum: ["impression", "click", "long_read", "share", "like", "dismiss"],
      index: true,
    },
    timeOfDay: {
      type: String,
      enum: ["morning", "midnoon", "evening", "night"],
    },
    position: Number,
    context: {
      district: String,
      device: String,
      network: String,
    },
    ts: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);
const Event = mongoose.model("Event", EventSchema);

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
  "https://news-dashboard-ob0p.onrender.com",
  "http://localhost:3000",
  "http://localhost:3001",
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
  // ✨ MODIFIED: Added clean source names for better detection
  const teluguSources = [
    "eenadu",
    "sakshi",
    "andhrajyothy",
    "ntnews",
    "manatelangana",
    "google.com/rss?hl=te",
    "ntv telugu",
    "tv9 telugu",
    "ht telugu",
    "10tv",
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

const SIMILARITY_THRESHOLD = 0.6;
const TIME_WINDOW_HOURS = 12;

// 6️⃣ Helper: Save article with classification
async function saveArticle(articleData) {
  try {
    const timeWindow = new Date();
    timeWindow.setHours(timeWindow.getHours() - TIME_WINDOW_HOURS);

    const recentArticles = await Article.find({
      publishedAt: { $gte: timeWindow },
      lang: articleData.lang,
    }).select("title");

    for (const recent of recentArticles) {
      const similarity = calculateJaccardSimilarity(
        articleData.title,
        recent.title
      );
      if (similarity >= SIMILARITY_THRESHOLD) {
        // console.log(
        //   `DUPLICATE DETECTED: "${articleData.title}" is similar to "${
        //     recent.title
        //   }" (Score: ${similarity.toFixed(2)})`
        // );
        return null;
      }
    }
  } catch (err) {
    console.error("Error during duplicate check:", err);
  }

  const { categories, topCategory } = classifyArticle(
    articleData.title + " " + (articleData.body || "")
  );
  articleData.categories = categories;
  articleData.topCategory = topCategory;

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
          isCreatedBy: "rss",
          publishedAt: item.publishedAt
            ? new Date(item.publishedAt)
            : new Date(),
          imageUrl: imageCandidate,
          media: imageCandidate ? [{ type: "image", src: imageCandidate }] : [],
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
      RSS_SOURCES.map((source) => parser.parseURL(source.url))
    );

    for (let i = 0; i < rssFeeds.length; i++) {
      const result = rssFeeds[i];
      const sourceInfo = RSS_SOURCES[i];

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
            source: sourceInfo.name || "RSS",
            isCreatedBy: "rss",
            publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
            imageUrl: extracted,
            media: extracted ? [{ type: "image", src: extracted }] : [],
          };
          articleData.lang = detectLanguage(
            articleData.title + " " + (articleData.body || ""),
            articleData.source
          );
          const saved = await saveArticle(articleData);
          if (saved) savedArticles.push(saved);
        }
      } else {
        console.warn(`RSS feed for ${sourceInfo.name} failed:`, result.reason);
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

app.post("/api/users/anonymous", async (req, res) => {
  try {
    const newUser = new User({ isAnonymous: true });
    await newUser.save();
    res.status(201).json({ userId: newUser._id });
  } catch (error) {
    console.error("Error creating anonymous user:", error);
    res.status(500).json({ error: "Failed to create anonymous user" });
  }
});

app.post("/api/events", async (req, res) => {
  try {
    const { userId, articleId, event, position, context, ts, timeOfDay } =
      req.body;
    if (!userId || !articleId || !event) {
      return res
        .status(400)
        .json({ error: "userId, articleId, and event are required" });
    }
    const newEvent = new Event({
      userId,
      articleId,
      event,
      position,
      context,
      timeOfDay,
      ts: ts ? new Date(ts) : new Date(),
    });
    await newEvent.save();
    res.status(201).json({ ok: true, id: newEvent._id });
  } catch (error) {
    console.error("Error logging event:", error);
    res.status(500).json({ error: "Failed to log event" });
  }
});

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

// 9️⃣ CRUD Endpoints for Articles
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


// ✨ NEW: Endpoint to create or update an article manually
app.post("/api/articles/manual", async (req, res) => {
  try {
    const {
      title,
      summary,
      body,
      source,
      imageUrl,
      isPublished = true,
      url,
    } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: "Title and body are required." });
    }

    const fullText = title + " " + body;
    const { categories, topCategory } = classifyArticle(fullText);
    const lang = detectLanguage(fullText, source);
    const finalImageUrl = imageUrl || FALLBACK_IMAGE;

    // ✅ Always provide a fallback unique URL if none supplied
    const finalUrl =
      url ||
      `manual-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // ✅ Use upsert (update if exists, insert if not)
    const result = await Article.updateOne(
      { url: finalUrl }, // match by unique URL
      {
        $set: {
          title,
          summary: summary || body.substring(0, 150),
          body,
          source: source || "Manual Post",
          isPublished,
          isCreatedBy: "manual",
          publishedAt: new Date(),
          lang,
          categories,
          topCategory,
          imageUrl: finalImageUrl,
          media: [{ type: "image", src: finalImageUrl }],
          url: finalUrl,
        },
      },
      { upsert: true }
    );

    // ✅ Fetch the latest doc back for response
    const savedArticle = await Article.findOne({ url: finalUrl });

    res.status(201).json({
      message: result.upsertedCount > 0 ? "Article created" : "Article updated",
      article: savedArticle,
    });
  } catch (error) {
    console.error("Error creating manual article:", error);
    res.status(500).json({ error: "Failed to create/update manual article." });
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
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const { lang, category, type, source } = req.query;

    // Build filter object
    const filter = {};

    // Language filter
    if (lang) {
      filter.lang = lang;
    }

    // Category filter
    if (category) {
      if (category === "N/A") {
        filter.topCategory = { $in: [null, ""] };
      } else if (category !== "All") {
        filter.topCategory = category;
      }
    }

    // Source filter
    if (source && source !== "All") {
      filter.source = source;
    }

    // Type filter (Manual vs Fetched)
    if (type) {
      if (type === "manual") {
        filter.isCreatedBy = "manual";
      } else if (type === "Fetched") {
        filter.isCreatedBy = "rss";
      }
    }

    // Query DB
    const [articles, totalArticles] = await Promise.all([
      Article.find(filter)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit),
      Article.countDocuments(filter),
    ]);

    res.status(200).json({
      articles,
      currentPage: page,
      totalPages: Math.ceil(totalArticles / limit),
      totalArticles,
    });
  } catch (error) {
    console.error("Error fetching articles:", error);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

app.get("/api/manual-articles", async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Always filter for manual articles
    const filter = { isCreatedBy: "manual" };

    const [articles, totalArticles] = await Promise.all([
      Article.find(filter)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit),
      Article.countDocuments(filter),
    ]);

    res.status(200).json({
      articles,
      currentPage: page,
      totalPages: Math.ceil(totalArticles / limit),
      totalArticles,
    });
  } catch (error) {
    console.error("Error fetching manual articles:", error);
    res.status(500).json({ error: "Failed to fetch manual articles" });
  }
});



app.get("/api/articles/total", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { lang } = req.query;

    const filter = {};
    if (lang) {
      filter.lang = lang;
    }

    const articles = await Article.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalArticles = await Article.countDocuments(filter);

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
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    // Force isCreatedBy = "manual" when updating
    const updateData = {
      ...req.body,
      isCreatedBy: "manual",
    };

    const updatedArticle = await Article.findByIdAndUpdate(id, updateData, {
      new: true,
    });

    if (!updatedArticle) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.status(200).json(updatedArticle);
  } catch (error) {
    console.error("Error updating article:", error);
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

//  Cron Job: Every 10 minutes
cron.schedule("*/10 * * * *", async () => {
  console.log("⏰ Cron triggered fetchNews");
  await fetchNews();
});

// 🔟 Start Server
app.listen(port, async () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  // await fetchNews(); // run once on startup
});
