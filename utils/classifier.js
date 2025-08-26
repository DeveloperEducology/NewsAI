export const CATEGORY_KEYWORDS = {
  politics: ["government", "minister", "election", "parliament"],
  business: ["business", "market", "stock", "finance", "economy"],
  sports: ["cricket", "football", "tennis", "match", "tournament"],
  technology: ["tech", "AI", "software", "app", "startup"],
  entertainment: ["movie", "actor", "music", "celebrity"],
};

export function classifyArticle(text) {
  const lowerText = text.toLowerCase();
  const categories = {};

  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lowerText.includes(kw)) score += 1;
    }
    if (score > 0) categories[cat] = score;
  }

  let topCategory = null;
  if (Object.keys(categories).length) {
    topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0][0];
  }

  return { categories, topCategory };
}
