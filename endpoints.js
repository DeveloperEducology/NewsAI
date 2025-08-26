// --- Endpoint: Fetch & Save News ---
app.get("/fetch-news", async (req, res) => {
  try {
    const url = `https://newsapi.org/v2/top-headlines?country=us&category=business&apiKey=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    console.log("data", data);

    if (!data.articles) {
      return res.status(500).json({ error: "No articles returned" });
    }

    const savedArticles = [];
    for (const item of data.articles) {
      const articleData = {
        title: item.title,
        summary: item.description,
        body: item.content || item.description,
        source: item.source.name,
        url: item.url,
        publishedAt: new Date(item.publishedAt),
      };

      // Upsert to avoid duplicates
      const result = await Article.updateOne(
        { url: articleData.url },
        { $setOnInsert: articleData },
        { upsert: true }
      );

      if (result.upsertedCount > 0) savedArticles.push(articleData);
    }

    res.json({
      message: "News fetched and saved successfully",
      count: savedArticles.length,
      articles: savedArticles,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

// 6️⃣ RSS Endpoint
app.get("/rss", async (req, res) => {
  try {
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

      await Article.updateOne(
        { url: articleData.url },
        { $setOnInsert: articleData },
        { upsert: true }
      );
    }

    res.json({ message: "RSS feed fetched and saved." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch RSS feed." });
  }
});

// 7️⃣ Scraping Endpoint
app.get("/scrape", async (req, res) => {
  try {
    const response = await fetch("https://www.example-news-website.com");
    const html = await response.text();

    const $ = cheerio.load(html);
    const articles = [];

    $("article").each((i, el) => {
      const title = $(el).find("h2").text().trim();
      const url = $(el).find("a").attr("href");
      const summary = $(el).find("p").text().trim();
      const publishedAt = new Date();

      if (title && url) {
        articles.push({
          title,
          summary,
          body: summary,
          url,
          source: "Example",
          publishedAt,
        });
      }
    });

    for (const articleData of articles) {
      await Article.updateOne(
        { url: articleData.url },
        { $setOnInsert: articleData },
        { upsert: true }
      );
    }

    res.json({ message: "Scraping completed.", count: articles.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to scrape website." });
  }
});
